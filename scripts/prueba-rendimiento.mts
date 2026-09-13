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
  resumirVentana,
  compararVentanas,
  variacionPct,
  ventanaMovil,
  movilesPorCarga,
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

// ── 14. COMPARAR DOS VENTANAS · la descomposición del gasto ────────────────
// Tres causas mueven el gasto y se gestionan de forma opuesta: más km es más trabajo,
// peor rendimiento es una anomalía, y un precio más alto es del mercado. La ficha las
// separa en soles, y lo único que no se puede aflojar es que sumen exacto.

/** Cargas de una ventana con km, galones y soles ya cuadrados. */
function ventana(
  idBase: number, desde: string, kmPorTramo: number, galPorTramo: number, precio: number, n: number
): CargaRendimiento[] {
  const out: CargaRendimiento[] = [];
  let km = 100000;
  const d = new Date(desde + "T00:00:00Z");
  for (let i = 0; i <= n; i++) {
    out.push({
      id: idBase + i, unidad: "pV", fecha: d.toISOString().slice(0, 10),
      kilometraje: km, cantidad: galPorTramo, tipo: "diesel",
      gasto: Math.round(galPorTramo * precio * 100) / 100,
    });
    km += kmPorTramo;
    d.setUTCDate(d.getUTCDate() + 3);
  }
  return out;
}

const resumir = (cargas: CargaRendimiento[], desde: string, hasta: string) =>
  resumirVentana(seriesRendimiento(cargas), cargas, desde, hasta);

{
  // Base: 280 km por tramo, 10 gal, S/ 24.70 → 28 km/gal.
  const prev = ventana(1000, "2026-07-01", 280, 10, 24.7, 6);
  // Actual: más km (320/tramo), peor rendimiento (12 gal → 26.67) y precio más alto.
  const act = ventana(2000, "2026-08-01", 320, 12, 25.74, 6);

  const rp = resumir(prev, "2026-07-01", "2026-07-31");
  const ra = resumir(act, "2026-08-01", "2026-08-31");
  const c = compararVentanas(ra, rp);

  chk("la ventana resume solo tramos medidos", rp.cargasMedidas === 6 && ra.cargasMedidas === 6, `${rp.cargasMedidas} / ${ra.cargasMedidas}`);
  chk("el rendimiento de la ventana es Σkm/Σgal", cerca(rp.rendimiento, 28, 0.01) && cerca(ra.rendimiento, 320 / 12, 0.01), `${rp.rendimiento?.toFixed(2)} → ${ra.rendimiento?.toFixed(2)}`);
  chk("el precio medio es Σgasto/Σgal", cerca(rp.precioMedio, 24.7, 0.01) && cerca(ra.precioMedio, 25.74, 0.01));
  chk("es comparable", c.comparable);

  const e = c.efectos!;
  chk("LOS TRES EFECTOS SUMAN LA DIFERENCIA DE GASTO (al céntimo)",
    Math.abs(e.km + e.rendimiento + e.precio - e.total) < 0.01,
    `${(e.km + e.rendimiento + e.precio).toFixed(4)} vs ${e.total.toFixed(4)}`);
  chk("más km sube el gasto", e.km > 0, e.km.toFixed(2));
  chk("peor rendimiento sube el gasto", e.rendimiento > 0, e.rendimiento.toFixed(2));
  chk("precio más alto sube el gasto", e.precio > 0, e.precio.toFixed(2));
  console.log(`        Δ S/ ${e.total.toFixed(2)} = km ${e.km.toFixed(2)} + rend ${e.rendimiento.toFixed(2)} + precio ${e.precio.toFixed(2)}`);
}

// ── 15. Cada efecto AISLADO: los otros dos en cero ─────────────────────────
{
  // Solo cambian los km.
  const p = ventana(3000, "2026-07-01", 280, 10, 24.7, 6);
  const a = ventana(4000, "2026-08-01", 420, 15, 24.7, 6); // 420/15 = 28 km/gal, mismo precio
  const c = compararVentanas(resumir(a, "2026-08-01", "2026-08-31"), resumir(p, "2026-07-01", "2026-07-31"));
  chk("solo cambia el km · efecto rendimiento = 0", Math.abs(c.efectos!.rendimiento) < 0.01, c.efectos!.rendimiento.toFixed(4));
  chk("solo cambia el km · efecto precio = 0", Math.abs(c.efectos!.precio) < 0.01, c.efectos!.precio.toFixed(4));
  chk("solo cambia el km · todo el cambio es del km", Math.abs(c.efectos!.km - c.efectos!.total) < 0.01);
}
{
  // Solo cambia el PRECIO. Es el caso real: diésel de S/ 24.70 a S/ 25.74 (+4.2 %).
  // Sin separar el precio, ese aumento se leería como problema operativo.
  const p = ventana(5000, "2026-07-01", 280, 10, 24.7, 6);
  const a = ventana(6000, "2026-08-01", 280, 10, 25.74, 6);
  const c = compararVentanas(resumir(a, "2026-08-01", "2026-08-31"), resumir(p, "2026-07-01", "2026-07-31"));
  chk("CASO REAL · solo sube el precio: efecto km = 0", Math.abs(c.efectos!.km) < 0.01, c.efectos!.km.toFixed(4));
  chk("CASO REAL · y NADA se le achaca al rendimiento", Math.abs(c.efectos!.rendimiento) < 0.01, c.efectos!.rendimiento.toFixed(4));
  chk("CASO REAL · todo el aumento es del precio", Math.abs(c.efectos!.precio - c.efectos!.total) < 0.01, `${c.efectos!.precio.toFixed(2)} de ${c.efectos!.total.toFixed(2)}`);
  chk("y el rendimiento no se movió", Math.abs(c.variacion.rendimiento ?? 99) < 0.01, String(c.variacion.rendimiento));
}
{
  // Solo cambia el RENDIMIENTO: mismos km, mismo precio, más galones.
  const p = ventana(7000, "2026-07-01", 280, 10, 24.7, 6);
  const a = ventana(8000, "2026-08-01", 280, 12, 24.7, 6);
  const c = compararVentanas(resumir(a, "2026-08-01", "2026-08-31"), resumir(p, "2026-07-01", "2026-07-31"));
  chk("solo cambia el rendimiento · efecto km = 0", Math.abs(c.efectos!.km) < 0.01, c.efectos!.km.toFixed(4));
  chk("solo cambia el rendimiento · efecto precio = 0", Math.abs(c.efectos!.precio) < 0.01, c.efectos!.precio.toFixed(4));
  chk("solo cambia el rendimiento · sube el gasto y se le achaca a él", c.efectos!.rendimiento > 0 && Math.abs(c.efectos!.rendimiento - c.efectos!.total) < 0.01);
}

// ── 16. Solo entran tramos MEDIDOS, y el gasto total se publica aparte ──────
{
  const cargas: CargaRendimiento[] = [
    { id: 1, unidad: "pW", fecha: "2026-08-01", kilometraje: 10000, cantidad: 10, tipo: "diesel", gasto: 247 },
    { id: 2, unidad: "pW", fecha: "2026-08-05", kilometraje: 10280, cantidad: 10, tipo: "diesel", gasto: 247 }, // medido
    { id: 3, unidad: "pW", fecha: "2026-08-09", kilometraje: 0, cantidad: 10, tipo: "diesel", gasto: 300 },     // sin odómetro
    { id: 4, unidad: "pW", fecha: "2026-08-13", kilometraje: 10560, cantidad: 10, tipo: "diesel", gasto: 247 }, // eslabón saltado
  ];
  const r = resumir(cargas, "2026-08-01", "2026-08-31");
  chk("un solo tramo medido de cuatro cargas", r.cargasMedidas === 1, String(r.cargasMedidas));
  chk("los galones sin medir NO entran al denominador", r.cantidad === 10, String(r.cantidad));
  chk("el gasto medido son solo los soles de ese tramo", cerca(r.gasto, 247, 0.01), String(r.gasto));
  chk("pero gastoTotal trae TODAS las cargas (lo que cuadra con caja)", cerca(r.gastoTotal, 1041, 0.01), String(r.gastoTotal));
  chk("y son números distintos, que es el punto", r.gasto !== r.gastoTotal);
  chk("la cobertura declara las cargas sin odómetro", r.cargasSinOdometro === 1, String(r.cargasSinOdometro));
  chk("el rendimiento no se contamina: 28 km/gal", cerca(r.rendimiento, 28, 0.01), String(r.rendimiento?.toFixed(2)));
}

// ── 17. Sin base no se compara: nunca −100 % ni Infinity ───────────────────
{
  const a = ventana(9000, "2026-08-01", 280, 10, 24.7, 6);
  const vacia = resumir([], "2026-07-01", "2026-07-31");
  const c = compararVentanas(resumir(a, "2026-08-01", "2026-08-31"), vacia);
  chk("periodo anterior vacío → NO comparable", c.comparable === false);
  chk("sin efectos inventados", c.efectos === null);
  chk("y con motivo que lo explica", (c.motivo ?? "").includes("periodo anterior"), c.motivo?.slice(0, 60) ?? "null");
  chk("el motivo dice que NO hay cargas, no solo que no hay tramos", /no tiene ninguna carga/.test(c.motivo ?? ""), c.motivo?.slice(0, 70) ?? "null");
}
{
  // EL CASO REAL DE CWZ-371, y por eso está aquí: julio tiene DOS cargas por S/ 466.75
  // y cero tramos medibles. Decir solo "no hay tramos medidos" sobre un periodo con
  // cargas visibles en la tabla hace dudar de la pantalla — el mensaje tiene que nombrar
  // la plata que sí hay y qué falta para poder medirla.
  const julio = resumir(CWZ.map(c => ({ ...c, gasto: 100 })), "2026-07-01", "2026-08-07");
  const agosto = resumir(CWZ.map(c => ({ ...c, gasto: 100 })), "2026-08-08", "2026-09-06");
  const c = compararVentanas(agosto, julio);
  chk("CWZ-371 · julio no es comparable", c.comparable === false);
  chk("CWZ-371 · pero el motivo NOMBRA las cargas que sí hay", /2 carga\(s\) por S\//.test(c.motivo ?? ""), c.motivo?.slice(0, 80) ?? "null");
  chk("CWZ-371 · y dice cómo arreglarlo", /poner el od[óo]metro/.test(c.motivo ?? ""));
}
{
  // Una sola carga no es lo mismo que cargas sin odómetro: se dicen distinto.
  const una = resumir([{ id: 1, unidad: "pU", fecha: "2026-07-10", kilometraje: 5000, cantidad: 10, tipo: "diesel", gasto: 247 }], "2026-07-01", "2026-07-31");
  const buena = resumir(ventana(20000, "2026-08-01", 280, 10, 24.7, 6), "2026-08-01", "2026-08-31");
  const c = compararVentanas(buena, una);
  chk("una sola carga: el motivo lo dice así", /una sola carga no hay tramo/.test(c.motivo ?? ""), c.motivo?.slice(0, 70) ?? "null");
  chk("las variaciones son null, no −100", c.variacion.km === null && c.variacion.rendimiento === null);
  chk("variacionPct sin base devuelve null", variacionPct(50, 0) === null);
  chk("variacionPct normal", cerca(variacionPct(110, 100), 10, 0.001));
  chk("variacionPct a la baja", cerca(variacionPct(90, 100), -10, 0.001));
  chk("variacionPct con null devuelve null", variacionPct(null, 100) === null && variacionPct(100, null) === null);
}

// ── 18. Pocos tramos: se compara, pero se dice que es orientativo ──────────
{
  const p = ventana(11000, "2026-07-01", 280, 10, 24.7, 2); // 2 tramos
  const a = ventana(12000, "2026-08-01", 280, 10, 24.7, 6);
  const c = compararVentanas(resumir(a, "2026-08-01", "2026-08-31"), resumir(p, "2026-07-01", "2026-07-31"));
  chk("con 2 tramos SÍ se compara (esconderlo sería peor)", c.comparable === true);
  chk("pero el motivo avisa que es orientativo", /[Oo]rientativo/.test(c.motivo ?? ""), c.motivo?.slice(0, 50) ?? "null");
  chk("y nombra cuántos tramos hay", (c.motivo ?? "").includes("2 tramo"), c.motivo?.slice(0, 60) ?? "null");
}

// ── 19. Dos ventanas idénticas: todo en cero, sin ruido ────────────────────
{
  const p = ventana(13000, "2026-07-01", 280, 10, 24.7, 6);
  const a = ventana(14000, "2026-08-01", 280, 10, 24.7, 6);
  const c = compararVentanas(resumir(a, "2026-08-01", "2026-08-31"), resumir(p, "2026-07-01", "2026-07-31"));
  chk("periodos idénticos · los tres efectos en 0", [c.efectos!.km, c.efectos!.rendimiento, c.efectos!.precio].every((x) => Math.abs(x) < 0.01));
  chk("periodos idénticos · variación 0 %", Math.abs(c.variacion.gasto ?? 99) < 0.01 && Math.abs(c.variacion.rendimiento ?? 99) < 0.01);
}

// ── 20. Bordes de la ventana ───────────────────────────────────────────────
{
  const vacia = resumir([], "2026-08-01", "2026-08-31");
  chk("ventana vacía no revienta", vacia.cargas === 0 && vacia.km === 0);
  chk("y sus ratios son null, no 0 ni NaN", vacia.rendimiento === null && vacia.precioMedio === null && vacia.costoKm === null);
  chk("los días se cuentan inclusive", vacia.dias === 31, String(vacia.dias));
  chk("una ventana de un día cuenta 1", resumir([], "2026-08-05", "2026-08-05").dias === 1);

  // Nada produce Infinity ni NaN.
  const raros: CargaRendimiento[] = [
    { id: 1, unidad: "pB", fecha: "2026-08-01", kilometraje: 100, cantidad: 0, tipo: "diesel", gasto: 0 },
    { id: 2, unidad: "pB", fecha: "2026-08-02", kilometraje: 100, cantidad: 10, tipo: "diesel", gasto: null },
    { id: 3, unidad: "pB", fecha: "2026-08-03", kilometraje: null, cantidad: null, tipo: null, gasto: undefined },
  ];
  const r = resumir(raros, "2026-08-01", "2026-08-31");
  const sano = [r.km, r.cantidad, r.gasto, r.gastoTotal, r.rendimiento, r.precioMedio, r.costoKm]
    .every((n) => n === null || Number.isFinite(n));
  chk("ninguna entrada rara produce Infinity ni NaN", sano);
  const c = compararVentanas(r, r);
  chk("comparar una ventana degenerada consigo misma no revienta", c.comparable === false || c.efectos !== null);
}

// ── 21. La ventana recorta por FECHA de la carga que cierra el tramo ───────
{
  const todas = ventana(15000, "2026-07-20", 280, 10, 24.7, 12); // cruza julio → agosto
  const jul = resumir(todas, "2026-07-01", "2026-07-31");
  const ago = resumir(todas, "2026-08-01", "2026-08-31");
  chk("cada carga cae en UNA sola ventana", jul.cargas + ago.cargas === todas.length, `${jul.cargas} + ${ago.cargas} de ${todas.length}`);
  chk("y los tramos medidos se reparten sin duplicarse", jul.cargasMedidas + ago.cargasMedidas <= todas.length - 1);
  chk("las dos ventanas miden algo", jul.cargasMedidas > 0 && ago.cargasMedidas > 0, `${jul.cargasMedidas} / ${ago.cargasMedidas}`);
}

// ── LA UNIDAD BICOMBUSTIBLE ─────────────────────────────────────────────────
//
// La CWQ400 es una van BICOMBUSTIBLE: carga GLP casi siempre y gasolina pocas veces (para el
// aire acondicionado y cuando el motor pide fuerza — subidas, acelerones). Las dos cadenas se
// miden por separado, así que los km hechos con el OTRO combustible caen igual en el delta del
// odómetro y NO están en el denominador.
//
// La cadena de gasolina es la que se rompe de forma escandalosa: entre dos cargas de gasolina
// pasan semanas de GLP, así que salen cientos de km/gal → por encima del techo de 40 →
// `implausible`, que la pantalla titula "Falta registrar una carga" y que en el Radar BLOQUEA el
// voucher. Es un rojo falso que manda a buscar un repostaje que nunca faltó.
const cargaBi = (
  id: number, fecha: string, km: number, cant: number, tipo: string
): CargaRendimiento => ({ id, unidad: "CWQ400", fecha, kilometraje: km, cantidad: cant, unidadCantidad: "galones", tipo });

{
  // 1º ene GLP · 5 ene gasolina (5 gal) · 20 ene GLP … · 15 feb gasolina
  const cargas = [
    cargaBi(1, "2026-01-01", 10000, 9.4, "glp"),
    cargaBi(2, "2026-01-05", 10200,  5.0, "gasolina_regular"),
    cargaBi(3, "2026-01-20", 10840, 9.4, "glp"),
    cargaBi(4, "2026-02-15", 12300,  5.0, "gasolina_regular"),
  ];
  const series = seriesRendimiento(cargas);
  const porCarga = tramosPorCarga(series);

  // El tramo de GASOLINA: 2100 km / 5 gal = 420 km/gal. Antes: "implausible".
  const gasolina = porCarga[4].tramo;
  chk("el tramo de gasolina de una bicombustible NO dice 'falta registrar una carga'",
    gasolina.motivo === "familia_cruzada", String(gasolina.motivo));
  chk("…y conserva el número descartado para no esconderlo",
    gasolina.crudo != null && gasolina.crudo > 100, String(gasolina.crudo));
  chk("…y el detalle nombra el otro combustible, no un repostaje ausente",
    /BICOMBUSTIBLE/i.test(gasolina.detalle) && /no est[áa] en esta cuenta/i.test(gasolina.detalle),
    gasolina.detalle);
  // No basta con que el texto EVITE hablar de cargas que faltan: tiene que DESMENTIRLO, porque
  // esa es la conclusión a la que llega solo quien ve un rendimiento imposible.
  chk("…y desmiente explícitamente que sea una carga sin registrar",
    /No es una carga que falte registrar/i.test(gasolina.detalle), gasolina.detalle);

  // El tramo de GLP del 20-ene también está contaminado: la gasolina del 5 cae dentro.
  const glp = porCarga[3].tramo;
  chk("el tramo de GLP que envuelve un repostaje de gasolina tampoco se publica",
    glp.motivo === "familia_cruzada" && glp.rendimiento === null, String(glp.motivo));

  chk("la etiqueta corta existe", etiquetaMotivo("familia_cruzada") === "bicombustible");
  chk("la invariante se mantiene: rendimiento XOR motivo",
    [...series.values()].every((s) => s.tramos.every((t) => (t.rendimiento != null) !== (t.motivo != null))));
}

// EL LADO QUE NO SE PUEDE AFLOJAR (1): la UREA no es un segundo combustible. Un camión diésel
// que carga AdBlue NO es bicombustible — la urea no mueve el bus — y contarla como cruce
// borraría el rendimiento de media flota.
{
  const cargas = [
    cargaBi(1, "2026-01-01", 10000, 50, "diesel"),
    cargaBi(2, "2026-01-10", 10300, 20, "urea"),
    cargaBi(3, "2026-01-20", 10600, 50, "diesel"),
  ];
  const t = tramosPorCarga(seriesRendimiento(cargas))[3].tramo;
  chk("la urea NO cruza el tramo del diésel", t.motivo === null && t.rendimiento === 12,
    `${t.motivo}/${t.rendimiento}`);
}

// EL LADO QUE NO SE PUEDE AFLOJAR (2): una unidad de UN solo combustible mide igual que siempre,
// y un "falta registrar una carga" REAL sigue saliendo. Silenciarlo sería peor que el falso.
{
  const cargas = [
    cargaBi(1, "2026-01-01", 10000, 9.4, "glp"),
    cargaBi(2, "2026-01-20", 10840, 9.4, "glp"),
  ];
  const t = tramosPorCarga(seriesRendimiento(cargas))[2].tramo;
  chk("sin segundo combustible, el hueco de registro sigue delatándose",
    t.motivo === "implausible", String(t.motivo));

  // Y sin marcas, la firma vieja da EXACTAMENTE lo mismo: quien ya filtraba por familia antes
  // de llamar (lib/costeo-servicio.ts) no cambia de comportamiento.
  const sinMarcas = serieRendimiento(cargas);
  const conVacio = serieRendimiento(cargas, []);
  chk("la firma sin marcas se comporta igual que antes",
    JSON.stringify(sinMarcas) === JSON.stringify(conVacio));
}

// El borde del intervalo: el combustible de una carga se quema DESPUÉS de su lectura.
{
  const cargas = [
    cargaBi(1, "2026-01-01", 10000, 10, "glp"),
    cargaBi(2, "2026-01-10", 10300, 10, "glp"),
  ];
  const enElCierre = serieRendimiento(cargas, [
    { id: 9, fecha: "2026-01-10", kilometraje: 10300, familia: "gasolina" },
  ]);
  chk("una carga del otro combustible en el km de CIERRE es del tramo siguiente",
    enElCierre.tramos[1].motivo === null, String(enElCierre.tramos[1].motivo));
  const enLaApertura = serieRendimiento(cargas, [
    { id: 9, fecha: "2026-01-01", kilometraje: 10000, familia: "gasolina" },
  ]);
  chk("y en el km de APERTURA sí se consumió dentro del tramo",
    enLaApertura.tramos[1].motivo === "familia_cruzada", String(enLaApertura.tramos[1].motivo));
  // Sin odómetro se cae a la fecha: sus galones movieron el bus igual.
  const sinKm = serieRendimiento(cargas, [
    { id: 9, fecha: "2026-01-05", kilometraje: null, familia: "gasolina" },
  ]);
  chk("una carga del otro combustible sin odómetro se ubica por fecha",
    sinKm.tramos[1].motivo === "familia_cruzada", String(sinKm.tramos[1].motivo));
}

// ─────────────────────────────────────────────────────────────────────────────
// TANDA 2 · A) TANQUE LLENO A TANQUE LLENO
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n── Tanda 2 · método tanque lleno ──────────────────────────────");

  // Base: 3 cargas, 100 km y 10 gal cada tramo → 10 km/gal limpio.
  const base = (tl: (boolean | null | undefined)[]): CargaRendimiento[] =>
    [0, 1, 2].map((i) => ({
      id: i + 1, unidad: "p1", fecha: `2026-03-0${i + 1}`,
      kilometraje: 1000 + i * 100, cantidad: 10, tipo: "diesel",
      ...(tl[i] === undefined ? {} : { tanqueLleno: tl[i] }),
    }));

  // LO QUE NO SE PUEDE AFLOJAR: sin el campo, el resultado es el de siempre.
  const legado = serieRendimiento(base([undefined, undefined, undefined]));
  chk("sin `tanqueLleno` el comportamiento es idéntico al de siempre",
    legado.tramos.map((t) => t.motivo ?? "ok").join("|") === "primera_carga|ok|ok",
    legado.tramos.map((t) => t.motivo ?? "ok").join("|"));
  chk("…y su número no se mueve", cerca(legado.tramos[1].rendimiento, 10), String(legado.tramos[1].rendimiento));

  // Todas llenas: igual que el legado.
  const llenas = serieRendimiento(base([true, true, true]));
  chk("con todas llenas mide igual que el legado",
    cerca(llenas.tramos[1].rendimiento, 10) && cerca(llenas.tramos[2].rendimiento, 10),
    `${llenas.tramos[1].rendimiento} / ${llenas.tramos[2].rendimiento}`);

  // LA PARCIAL DEL MEDIO NO ROMPE NADA: se absorbe y el tramo ancla→ancla mide 200 km / 20 gal.
  const conParcial = serieRendimiento(base([true, false, true]));
  chk("la carga parcial no cierra medición", conParcial.tramos[1].motivo === "tanque_parcial",
    String(conParcial.tramos[1].motivo));
  chk("…y sus km quedan en null para no contarse dos veces", conParcial.tramos[1].km === null,
    String(conParcial.tramos[1].km));
  chk("el tramo ancla→ancla abarca los DOS tramos", conParcial.tramos[2].km === 200,
    String(conParcial.tramos[2].km));
  chk("…y absorbe el combustible de la parcial", conParcial.tramos[2].cantidad === 20,
    String(conParcial.tramos[2].cantidad));
  chk("…así que el rendimiento NO se infla", cerca(conParcial.tramos[2].rendimiento, 10),
    String(conParcial.tramos[2].rendimiento));
  chk("…y declara a quién absorbió", conParcial.tramos[2].absorbidas.join(",") === "2",
    conParcial.tramos[2].absorbidas.join(","));

  // EL BUG QUE ESTO EVITA: invalidar los dos tramos que tocan una parcial perdería su
  // combustible de toda cuenta. Aquí el denominador lo conserva entero.
  chk("el combustible de la parcial NO se pierde",
    conParcial.resumen.cantidadMedida === 20, String(conParcial.resumen.cantidadMedida));

  // `null` se absorbe igual que la parcial —la cuenta sale bien fuera llena o parcial— pero
  // con motivo propio, porque se arregla en otro sitio.
  const desconocida = serieRendimiento(base([true, null, true]));
  chk("la carga sin declarar tiene motivo propio", desconocida.tramos[1].motivo === "tanque_desconocido",
    String(desconocida.tramos[1].motivo));
  chk("…y se absorbe igual que la parcial", cerca(desconocida.tramos[2].rendimiento, 10),
    String(desconocida.tramos[2].rendimiento));
  chk("…y su motivo manda a marcar la casilla",
    /tanque lleno/i.test(textoMotivo("tanque_desconocido", desconocida.tramos[1])));

  // Sin ancla previa no hay tramo que medir: es `primera_carga`, no un número inventado.
  const arrancaParcial = serieRendimiento(base([false, true, true]));
  chk("lo absorbido antes de la primera ancla no se arrastra",
    arrancaParcial.tramos[1].motivo === "primera_carga" && arrancaParcial.tramos[1].km === null,
    `${arrancaParcial.tramos[1].motivo}/${arrancaParcial.tramos[1].km}`);
  chk("…y el primer tramo medible no hereda su combustible",
    arrancaParcial.tramos[2].cantidad === 10, String(arrancaParcial.tramos[2].cantidad));

  chk("la invariante se mantiene con tanque",
    [...llenas.tramos, ...conParcial.tramos, ...desconocida.tramos]
      .every((t) => (t.rendimiento !== null) !== (t.motivo !== null)));
  for (const m of ["tanque_parcial", "tanque_desconocido"] as MotivoSinRendimiento[]) {
    chk(`${m} tiene etiqueta corta`, etiquetaMotivo(m).length > 0, etiquetaMotivo(m));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TANDA 2 · B) EL COSTO POR KM NO HEREDA EL FILTRO DEL RENDIMIENTO
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n── Tanda 2 · costo por km (conjunto ①) ────────────────────────");

  // Una bicombustible: el tramo de GLP cruza una carga de gasolina, así que NO publica
  // rendimiento. Sus km se recorrieron igual y su plata se gastó igual.
  const cargas: CargaRendimiento[] = [
    { id: 1, unidad: "p1", fecha: "2026-04-01", kilometraje: 1000, cantidad: 10, tipo: "glp", gasto: 70 },
    { id: 2, unidad: "p1", fecha: "2026-04-10", kilometraje: 1200, cantidad: 10, tipo: "glp", gasto: 70 },
  ];
  const cruzada = serieRendimiento(cargas, [
    { id: 9, fecha: "2026-04-05", kilometraje: 1100, familia: "gasolina" },
  ]);
  chk("el tramo bicombustible no publica rendimiento", cruzada.tramos[1].motivo === "familia_cruzada",
    String(cruzada.tramos[1].motivo));
  chk("…pero sus km SÍ son de fiar", cruzada.tramos[1].kmConfiable === true,
    String(cruzada.tramos[1].kmConfiable));

  const series = new Map([["p1|glp", cruzada]]);
  const v = resumirVentana(series, cargas, "2026-04-01", "2026-04-30");
  chk("el rendimiento de la ventana es null (no hay tramo publicable)", v.rendimiento === null,
    String(v.rendimiento));
  chk("PERO el costo por km existe", v.costoKm !== null, String(v.costoKm));
  chk("…con los km del tramo descartado", v.kmRecorrido === 200, String(v.kmRecorrido));
  chk("…y S/ 70 / 200 km = 0.35", cerca(v.costoKm, 0.35, 0.001), String(v.costoKm));
  chk("…y declara su cobertura", cerca(v.coberturaCosto, 0.5, 0.001), String(v.coberturaCosto));

  // Un km MALO (dígito de más) sí queda fuera: ahí el odómetro no avanzó de verdad.
  const malo: CargaRendimiento[] = [
    { id: 1, unidad: "p2", fecha: "2026-04-01", kilometraje: 1000, cantidad: 10, tipo: "diesel", gasto: 250 },
    { id: 2, unidad: "p2", fecha: "2026-04-03", kilometraje: 1000000, cantidad: 10, tipo: "diesel", gasto: 250 },
  ];
  const sMalo = seriesRendimiento(malo);
  const vMalo = resumirVentana(sMalo, malo, "2026-04-01", "2026-04-30");
  chk("un km imposible NO entra al costo por km", vMalo.kmRecorrido === 0, String(vMalo.kmRecorrido));
  chk("…y el costo por km sale null en vez de un número absurdo", vMalo.costoKm === null,
    String(vMalo.costoKm));

  // La plata de una carga ABSORBIDA entra al numerador: si no, el costo saldría corto.
  const conParcial: CargaRendimiento[] = [
    { id: 1, unidad: "p3", fecha: "2026-05-01", kilometraje: 1000, cantidad: 10, tipo: "diesel", gasto: 250, tanqueLleno: true },
    { id: 2, unidad: "p3", fecha: "2026-05-05", kilometraje: 1100, cantidad: 10, tipo: "diesel", gasto: 250, tanqueLleno: false },
    { id: 3, unidad: "p3", fecha: "2026-05-09", kilometraje: 1200, cantidad: 10, tipo: "diesel", gasto: 250, tanqueLleno: true },
  ];
  const vPar = resumirVentana(seriesRendimiento(conParcial), conParcial, "2026-05-01", "2026-05-31");
  chk("el costo por km cuenta los km del tramo ancla→ancla", vPar.kmRecorrido === 200,
    String(vPar.kmRecorrido));
  chk("…y la plata de la parcial absorbida", vPar.gastoDelKm === 500, String(vPar.gastoDelKm));
  chk("…dando S/ 2.50 por km", cerca(vPar.costoKm, 2.5, 0.001), String(vPar.costoKm));
}

// ─────────────────────────────────────────────────────────────────────────────
// TANDA 2 · C) VENTANA MÓVIL
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n── Tanda 2 · ventana móvil ────────────────────────────────────");

  // 8 tramos a 10 km/gal y después una caída sostenida a 8: la mediana histórica apenas se
  // mueve, la ventana móvil lo ve.
  const rend = [10, 10, 10, 10, 10, 10, 10, 10, 8, 8, 8, 8, 8];
  const cargas: CargaRendimiento[] = [{ id: 1, unidad: "p1", fecha: "2026-01-01", kilometraje: 10000, cantidad: 10, tipo: "diesel" }];
  let km = 10000;
  rend.forEach((r, i) => {
    km += r * 10;
    cargas.push({
      id: i + 2, unidad: "p1", fecha: `2026-01-${String(i + 2).padStart(2, "0")}`,
      kilometraje: km, cantidad: 10, tipo: "diesel",
    });
  });
  const serie = serieRendimiento(cargas);
  const mov = ventanaMovil(serie);

  const primeros = mov.get(2);
  chk("la ventana no se inventa: al principio cuenta los tramos que hay",
    primeros?.tramos === 1, String(primeros?.tramos));
  const ultimo = mov.get(cargas[cargas.length - 1].id);
  chk("la ventana llena tiene 5 tramos", ultimo?.tramos === MIN_TRAMOS_CONFIABLE, String(ultimo?.tramos));
  chk("…y ya marca la caída sostenida", cerca(ultimo?.rendimiento ?? null, 8, 0.01),
    String(ultimo?.rendimiento));
  chk("es un ratio AGRUPADO (Σkm/Σcantidad), no un promedio de ratios",
    ultimo?.km === 400 && ultimo?.cantidad === 50, `${ultimo?.km}/${ultimo?.cantidad}`);

  // Y ESTE ES EL ARGUMENTO ENTERO: la mediana histórica no la ve todavía.
  chk("la mediana histórica sigue en 10 mientras la unidad ya rinde 8",
    cerca(serie.resumen.mediana, 10, 0.01), String(serie.resumen.mediana));
  chk("…y la desviación de la ventana lo DICE (−20 %)",
    cerca(ultimo?.desviacion ?? null, -0.2, 0.01), String(ultimo?.desviacion));

  // Solo tramos publicables, y solo de su propia serie.
  const conHueco = serieRendimiento([
    { id: 1, unidad: "p9", fecha: "2026-02-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p9", fecha: "2026-02-02", kilometraje: 1100, cantidad: 0, tipo: "diesel" },
    { id: 3, unidad: "p9", fecha: "2026-02-03", kilometraje: 1200, cantidad: 10, tipo: "diesel" },
  ]);
  const movHueco = ventanaMovil(conHueco);
  chk("un tramo sin número no entra a la ventana", !movHueco.has(2), String([...movHueco.keys()]));
  chk("…y el siguiente sí, con lo que hay", movHueco.get(3)?.tramos === 1, String(movHueco.get(3)?.tramos));

  const porCarga = movilesPorCarga(seriesRendimiento(cargas));
  chk("movilesPorCarga aplana lo mismo que ventanaMovil",
    porCarga[cargas[cargas.length - 1].id]?.rendimiento === ultimo?.rendimiento);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
