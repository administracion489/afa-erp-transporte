// Matriz del MANTENIMIENTO MEDIDO POR TIPO DE VEHÍCULO: cuánto costó de verdad mantener un
// kilómetro de cada tipo de `parametros_costos`, y si eso se puede proponer como parámetro.
// Uso:  npx tsx scripts/prueba-mantenimiento-tipo.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · LAS DOS INVARIANTES DEL AGREGADO. `proponible === (codigo === "medido")` y "hay número
//     exactamente en los seis códigos que lo tienen". Son lo que permite que la pantalla enrute
//     por CÓDIGO en vez de olfatear el texto: un código nuevo sin número, o un `proponible` que
//     se cuele en otro código, pone un botón que escribe dinero donde no debería.
//
// 2 · QUE `aportan` Y `observadas` SEAN DISJUNTAS Y EXHAUSTIVAS. Una placa que se ve en la flota
//     y no aparece en ninguna de las dos es una unidad que la pantalla no explica en ningún
//     sitio: el operador la busca y no está.
//
// 3 · QUE LA TASA NO SEA LA MEDIANA. Es la decisión de diseño que separa este módulo de su
//     gemelo del rendimiento, y la que más fácil se "arregla" por parecido. El mantenimiento es
//     a tirones: la mediana de los tramos descartaría la reparación mayor —que es un costo REAL
//     que ocurre cada tantos miles de km— y publicaría el costo de los meses tranquilos. Eso es
//     equivocarse hacia ABAJO, el error que no vuelve.
//
// 4 · LA CADENA. El costo se atribuye al tramo que la orden CIERRA (el mantenimiento se paga
//     después del desgaste que lo causó), la cabecera no aporta, una orden sin kilometraje la
//     recoge el tramo siguiente en vez de perderse, y un odómetro que retrocede o que salta lo
//     imposible descarta el tramo y RE-ANCLA en la lectura nueva.
//
// 5 · EL NEUMÁTICO QUE YA SE COBRA APARTE. Bloquea la propuesta y enseña las dos cifras, pero
//     NO se descuenta solo: excluir por texto una orden que apenas menciona una llanta dejaría
//     el costo medido por debajo del real, que es el lado caro.
//
// 6 · EL CASO QUE MOTIVÓ TODO (premium vs estándar), calculado con el motor de costo por km de
//     verdad: bajar SOLO la depreciación de una unidad usada la deja más barata de lo que es.
//
// 7 · EL LADO QUE NO SE PUEDE AFLOJAR (última sección). Todo lo de arriba RESTRINGE cuándo se
//     propone, así que el riesgo es apagar la funcionalidad sin que nadie lo note.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const MANT = requerir("../lib/costos/mantenimiento-tipo") as typeof import("../lib/costos/mantenimiento-tipo");
const CKM = requerir("../lib/costos/costo-km-parametro") as typeof import("../lib/costos/costo-km-parametro");

const {
  serieMantenimiento, agregarMantenimientoTipo, agregarMantenimientoPorTipo,
  cotejarAntiguedadTipo, procedenciaMantDeHistorial, motivoHistorialMant,
  etiquetaMant, pareceNeumatico, estimarPorPlan,
  PASO_MANTENIMIENTO, MIN_TRAMOS_MANT, CAMPO_DESCARTE_MANT,
} = MANT;
const { costoKmDeParametro } = CKM;

type OtMantenimiento = import("../lib/costos/mantenimiento-tipo").OtMantenimiento;
type PlacaMantenimiento = import("../lib/costos/mantenimiento-tipo").PlacaMantenimiento;
type CodigoMant = import("../lib/costos/mantenimiento-tipo").CodigoMant;

const HOY = "2026-09-11";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const cerca = (a: number | null, b: number, eps = 0.005) => a !== null && Math.abs(a - b) < eps;

// ── FIXTURES ──────────────────────────────────────────────────────────────────

let seqOt = 0;
function ot(o: Partial<OtMantenimiento> = {}): OtMantenimiento {
  return {
    id: ++seqOt, fecha: "2026-01-15", km: 10000, costo: 1500,
    estado: "finalizado", tipo: "preventivo", descripcion: "Servicio preventivo 5 000 km",
    ...o,
  };
}

/** N órdenes mensuales, +`kmPaso` km y S/`costo` cada una. La primera es la cabecera. */
function cadena(n: number, opts: { kmPaso?: number; costo?: number; km0?: number } = {}): OtMantenimiento[] {
  const { kmPaso = 5000, costo = 1500, km0 = 100000 } = opts;
  return Array.from({ length: n }, (_, i) =>
    ot({ fecha: `2026-${String(i + 1).padStart(2, "0")}-10`, km: km0 + i * kmPaso, costo })
  );
}

let seqPlaca = 0;
function placa(ots: OtMantenimiento[], o: Partial<PlacaMantenimiento> = {}): PlacaMantenimiento {
  const n = ++seqPlaca;
  return {
    uid: `p${n}`, vehiculoId: n, placa: `AAA-${String(n).padStart(3, "0")}`,
    flota: "propia", tipoCosteo: "BUS_50", anio: 2020,
    otsTotales: ots.length, serie: serieMantenimiento(ots, HOY),
    ...o,
  };
}

const BUS50 = { tipo_vehiculo: "BUS_50", nombre: "Bus 50 pax Diésel", mantenimiento_km: 1.20 };

// ══ 1 · LA CADENA ════════════════════════════════════════════════════════════
console.log("\n1 · LA CADENA: qué costo entra, en qué tramo y con qué kilómetros");

{
  // 7 órdenes, 6 tramos de 5 000 km y S/ 1 500 cada uno. La PRIMERA no aporta costo.
  const s = serieMantenimiento(cadena(7), HOY);
  chk("7 órdenes → 6 tramos", s.tramos.length === 6, `${s.tramos.length}`);
  chk("la cabecera no aporta su costo", s.resumen.costo === 9000, `S/ ${s.resumen.costo}`);
  chk("km = 6 × 5 000", s.resumen.km === 30000, `${s.resumen.km}`);
  chk("tasa = 9 000 / 30 000 = 0.30", cerca(s.resumen.soleskm, 0.30), `${s.resumen.soleskm}`);
  chk("la cabecera se NOMBRA, no se esconde", s.fuera.some((f) => f.motivo === "cabecera"));
  chk(`confiable con ${MIN_TRAMOS_MANT} tramos o más`, s.resumen.confiable === true);
}

{
  // El costo se atribuye al tramo que la orden CIERRA: el mantenimiento se paga DESPUÉS del
  // desgaste. Si se atribuyera al que abre, el primer tramo llevaría el costo de la cabecera.
  const s = serieMantenimiento([
    ot({ fecha: "2026-01-10", km: 100000, costo: 9999 }),   // cabecera cara: NO cuenta
    ot({ fecha: "2026-02-10", km: 105000, costo: 1000 }),
  ], HOY);
  chk("el costo es el de la orden que CIERRA el tramo", s.tramos[0].costo === 1000, `S/ ${s.tramos[0].costo}`);
  chk("el costo de la cabecera queda fuera", s.resumen.costo === 1000);
}

{
  // Una orden SIN kilometraje no rompe la cadena: su plata se gastó dentro de esos km igual, y
  // dejarla fuera publicaría un mantenimiento más barato que el real.
  const s = serieMantenimiento([
    ot({ fecha: "2026-01-10", km: 100000, costo: 500 }),
    ot({ fecha: "2026-01-20", km: null, costo: 800, descripcion: "Cambio de filtros (sin odómetro)" }),
    ot({ fecha: "2026-02-10", km: 105000, costo: 1200 }),
  ], HOY);
  chk("la orden sin km la recoge el tramo siguiente", s.tramos.length === 1 && s.tramos[0].costo === 2000,
    `S/ ${s.tramos[0]?.costo}`);
  chk("y cuenta como 2 órdenes en ese tramo", s.tramos[0].ots === 2);
  chk("no aparece como 'fuera'", !s.fuera.some((f) => f.motivo === "sin_kilometraje"));
}

{
  // La que queda colgando al final SÍ se declara: no hay tramo que la recoja.
  const s = serieMantenimiento([
    ot({ fecha: "2026-01-10", km: 100000, costo: 500 }),
    ot({ fecha: "2026-02-10", km: 105000, costo: 1200 }),
    ot({ fecha: "2026-03-10", km: null, costo: 700 }),
  ], HOY);
  chk("la última sin km se nombra", s.fuera.some((f) => f.motivo === "sin_kilometraje" && f.costo === 700));
  chk("y no infla la tasa", s.resumen.costo === 1200);
}

{
  // Anuladas y programadas: la primera es plata que nunca salió, la segunda no ha ocurrido.
  const s = serieMantenimiento([
    ot({ fecha: "2026-01-10", km: 100000, costo: 500 }),
    ot({ fecha: "2026-02-10", km: 105000, costo: 1200 }),
    ot({ fecha: "2026-02-15", km: 106000, costo: 5000, estado: "cancelado" }),
    ot({ fecha: "2026-12-01", km: 130000, costo: 8000, estado: "pendiente" }),
  ], HOY);
  chk("la anulada no entra", s.fuera.some((f) => f.motivo === "cancelada"));
  chk("la futura no entra", s.fuera.some((f) => f.motivo === "futura"));
  chk("la tasa solo cuenta lo ocurrido", s.resumen.costo === 1200, `S/ ${s.resumen.costo}`);
}

{
  // Odómetro que retrocede y salto imposible: se descarta el tramo y se RE-ANCLA en la lectura
  // nueva. Seguir con la vieja arrastraría el error a todos los tramos posteriores.
  const s = serieMantenimiento([
    ot({ fecha: "2026-01-10", km: 100000, costo: 500 }),
    ot({ fecha: "2026-02-10", km: 99000, costo: 900 }),     // retrocede
    ot({ fecha: "2026-03-10", km: 104000, costo: 1000 }),
  ], HOY);
  chk("el retroceso descarta su tramo", s.fuera.some((f) => f.motivo === "tramo_implausible"));
  chk("y re-ancla: el tramo siguiente sale de la lectura nueva", s.tramos.length === 1 && s.tramos[0].km === 5000,
    `${s.tramos[0]?.km} km`);

  const s2 = serieMantenimiento([
    ot({ fecha: "2026-01-10", km: 100000, costo: 500 }),
    ot({ fecha: "2026-01-12", km: 900000, costo: 900 }),    // 800 000 km en 2 días
  ], HOY);
  chk("el salto imposible (> km/día máx) descarta el tramo", s2.tramos.length === 0);
}

// ══ 2 · LA TASA, NO LA MEDIANA ═══════════════════════════════════════════════
console.log("\n2 · LA TASA (Σ soles ÷ Σ km), que NO es la mediana de los tramos");

{
  // Seis servicios baratos y una reparación mayor. La mediana diría 0.10 S/km; la verdad es que
  // mantener esa unidad costó 0.4286 S/km. Publicar la mediana sería costear sin la reparación.
  const ots = [
    ot({ fecha: "2026-01-10", km: 100000, costo: 0 }),                 // cabecera
    ...Array.from({ length: 6 }, (_, i) =>
      ot({ fecha: `2026-0${i + 2}-10`, km: 105000 + i * 5000, costo: 500 })),
    ot({ fecha: "2026-08-10", km: 135000, costo: 12000, descripcion: "Reparación de motor" }),
  ];
  const s = serieMantenimiento(ots, HOY);
  const tasas = s.tramos.map((t) => t.soleskm).sort((a, b) => a - b);
  const medianaTramos = tasas[Math.floor(tasas.length / 2)];
  chk("la tasa publicada NO es la mediana de los tramos",
    !cerca(s.resumen.soleskm, medianaTramos, 0.01), `tasa ${s.resumen.soleskm} · mediana ${medianaTramos}`);
  chk("la tasa incluye la reparación mayor", cerca(s.resumen.soleskm, 15000 / 35000),
    `${s.resumen.soleskm} S/km`);
}

{
  // Dos placas con kilometrajes muy distintos: la tasa del TIPO agrupa soles y km, no promedia
  // tasas. Promediar le daría el mismo peso a la que hizo 5 000 km que a la que hizo 100 000.
  const chica = placa(cadena(6, { kmPaso: 1000, costo: 2000 }));       // 5 tramos · 5 000 km · S/10 000 → 2.00
  const grande = placa(cadena(6, { kmPaso: 20000, costo: 2000 }));     // 5 tramos · 100 000 km · S/10 000 → 0.10
  const a = agregarMantenimientoTipo(BUS50, [chica, grande]);
  const promedioDeTasas = (2.00 + 0.10) / 2;
  chk("con dos placas se agrupa, no se promedia",
    !cerca(a.medido, promedioDeTasas, 0.01), `medido ${a.medido} · promedio de tasas ${promedioDeTasas}`);
  chk("agrupada = 20 000 / 105 000", cerca(a.medido, 20000 / 105000), `${a.medido}`);
  chk("y con dos votantes NO se propone", a.codigo === "varias_placas" && !a.proponible, a.codigo);
}

// ══ 3 · LOS CÓDIGOS Y SUS INVARIANTES ════════════════════════════════════════
console.log("\n3 · LOS CÓDIGOS: cada uno con su arreglo en otro sitio");

/** Los seis códigos que llevan número. El resto tiene que traer `medido: null`. */
const CON_NUMERO: CodigoMant[] = [
  "medido", "coincide", "descartado", "revisar_neumaticos", "varias_placas", "pocos_registros",
];

const casos: { nombre: string; placas: PlacaMantenimiento[]; param?: typeof BUS50; proc?: any; espera: CodigoMant }[] = [
  { nombre: "sin placas asignadas", placas: [], espera: "sin_placas" },
  { nombre: "solo unidades de tercero",
    placas: [placa([], { flota: "tercero", otsTotales: 0 })], espera: "solo_terceros" },
  { nombre: "propia sin órdenes", placas: [placa([])], espera: "sin_mantenimiento" },
  // Estos tres NO declaran intervalo de plan, así que el estimado no se dispara y el código sigue
  // siendo el motivo seco: es la forma de fijar que sin intervalo el comportamiento es el de antes.
  { nombre: "órdenes sin kilometraje",
    placas: [placa([ot({ km: null, costo: 900 }), ot({ km: 0, costo: 800, fecha: "2026-02-10" })])],
    espera: "sin_kilometraje" },
  { nombre: "una sola orden con kilometraje",
    placas: [placa([ot({ km: 120000, costo: 900 })])],
    espera: "una_sola_orden" },
  { nombre: "kilometrajes que no encadenan",
    placas: [placa([
      ot({ fecha: "2026-01-10", km: 120000, costo: 900 }),
      ot({ fecha: "2026-02-10", km: 110000, costo: 800 }),
    ])],
    espera: "kilometraje_incoherente" },
  { nombre: "una sola orden PREVENTIVA, con el intervalo del plan declarado",
    placas: [placa([ot({ km: 120000, costo: 900 })], { intervaloPlanKm: 5000 })],
    espera: "estimado_por_plan" },
  { nombre: "pocos tramos", placas: [placa(cadena(3))], espera: "pocos_registros" },
  { nombre: "medido", placas: [placa(cadena(7))], espera: "medido" },
  { nombre: "ya coincide",
    placas: [placa(cadena(7, { kmPaso: 5000, costo: 6000 }))],   // 36 000/30 000 = 1.20
    espera: "coincide" },
  { nombre: "revisa las llantas",
    placas: [placa([
      ...cadena(7),
      ot({ fecha: "2026-07-15", km: 132000, costo: 9000, descripcion: "Cambio de 6 llantas 295/80R22.5" }),
    ])],
    espera: "revisar_neumaticos" },
  { nombre: "lo miden varias unidades",
    placas: [placa(cadena(7)), placa(cadena(7, { costo: 3000 }))], espera: "varias_placas" },
];

for (const c of casos) {
  const a = agregarMantenimientoTipo(c.param ?? BUS50, c.placas, c.proc);
  chk(`código «${c.espera}» — ${c.nombre}`, a.codigo === c.espera, `salió ${a.codigo} · ${etiquetaMant(a.codigo)}`);

  // INVARIANTE 1
  chk(`  proponible === (codigo === "medido") — ${c.nombre}`, a.proponible === (a.codigo === "medido"));
  // INVARIANTE 2
  const deberiaTener = CON_NUMERO.includes(a.codigo);
  chk(`  hay número solo en los seis que lo tienen — ${c.nombre}`,
    (a.medido !== null) === deberiaTener, `codigo ${a.codigo} · medido ${a.medido}`);
  // aportan ∪ observadas = todas, y disjuntas
  const uids = new Set([...a.aportan.map((p) => p.uid), ...a.observadas.map((o) => o.placa.uid)]);
  chk(`  aportan y observadas: disjuntas y exhaustivas — ${c.nombre}`,
    uids.size === c.placas.length &&
    a.aportan.length + a.observadas.length === c.placas.length);
  // Nunca un cero disfrazado de medición
  chk(`  el medido nunca es 0 — ${c.nombre}`, a.medido === null || a.medido > 0);
}

{
  // «pocos tramos» ENSEÑA el número, a diferencia de su gemelo del rendimiento. El
  // mantenimiento se registra a tirones: esconderlo dejaría la columna vacía en toda la flota,
  // y una columna vacía se lee como "aquí no hay nada que medir".
  const a = agregarMantenimientoTipo(BUS50, [placa(cadena(3))]);
  chk("pocos tramos trae número igual", a.medido !== null && a.medido > 0, `${a.medido}`);
  chk("pero no se propone", !a.proponible);
}

{
  // El descarte apaga el chip mientras la medición no se mueva, y vuelve si se mueve.
  const p = placa(cadena(7));
  const medido = agregarMantenimientoTipo(BUS50, [p]).medido as number;
  const proc = { origen: "manual" as const, fecha: null, por: null, descartado: medido };
  chk("revisado y no adoptado → descartado",
    agregarMantenimientoTipo(BUS50, [p], proc).codigo === "descartado");
  const procViejo = { ...proc, descartado: medido + PASO_MANTENIMIENTO * 3 };
  chk("si la medición se mueve, vuelve a proponerse",
    agregarMantenimientoTipo(BUS50, [p], procViejo).codigo === "medido");
}

// ══ 3b · EL CASO REPORTADO: "TENGO 1 OT CON KM Y ME DICE QUE NO TIENE KM" ════
console.log("\n3b · UNA SOLA ORDEN: un rojo que decía tres cosas, y el intervalo del plan");

{
  // EL DEFECTO, tal como se vio en /configuracion/costos → 🔧 Mantenimiento. Una unidad con UNA
  // orden con kilometraje recibía el texto de `sin_kilometraje` — el ERP mandando a rellenar en
  // el Historial un odómetro que ya estaba puesto.
  const a = agregarMantenimientoTipo(BUS50, [placa([ot({ km: 120000, costo: 900 })])]);
  chk("una orden CON kilometraje ya no dice «sin kilometraje»", a.codigo !== "sin_kilometraje", a.codigo);
  chk("dice que falta la SEGUNDA orden", a.codigo === "una_sola_orden");
  chk("y no manda a corregir nada", !/se completa en/i.test(a.detalle) && /no falta ningún dato/i.test(a.detalle));

  // Y el caso opuesto sigue diciendo lo suyo: ahí el odómetro sí falta.
  const sinKm = agregarMantenimientoTipo(BUS50, [placa([ot({ km: null, costo: 900 })])]);
  chk("sin ningún odómetro SÍ manda al Historial",
    sinKm.codigo === "sin_kilometraje" && /Historial/.test(sinKm.detalle));

  // El tercero: hay dos lecturas y una es falsa. No falta un dato, sobra un número mal.
  const incoh = agregarMantenimientoTipo(BUS50, [placa([
    ot({ fecha: "2026-01-10", km: 120000, costo: 900 }),
    ot({ fecha: "2026-02-10", km: 110000, costo: 800 }),
  ])]);
  chk("dos odómetros que no encadenan tienen su propio código",
    incoh.codigo === "kilometraje_incoherente" && /número equivocado/i.test(incoh.detalle));

  // Los tres motivos llegan a la placa observada, no solo al tipo: el modal los lista por unidad.
  chk("el motivo viaja también en la placa observada",
    agregarMantenimientoTipo(BUS50, [placa([ot({ km: 120000, costo: 900 })])])
      .observadas[0].motivo === "una_sola_orden");
}

{
  // EL INTERVALO DEL PLAN convierte ese "no se puede medir nada" en un número. Servicio cada
  // 5 000 km a S/ 900 → 0.18 S/km del servicio programado.
  const p = placa([ot({ km: 120000, costo: 900 })], { intervaloPlanKm: 5000 });
  const a = agregarMantenimientoTipo(BUS50, [p]);
  chk("con el intervalo declarado, hay número", a.plan !== null && cerca(a.plan.soleskm, 0.18), `${a.plan?.soleskm}`);
  chk("el código lo declara", a.codigo === "estimado_por_plan");
  chk("y SIGUE nombrando por qué no hay medición", /segunda orden|cierra la orden siguiente|UNA orden/i.test(a.detalle));

  // LO QUE NO SE PUEDE AFLOJAR NUNCA: este número no se propone. Mide el servicio programado, no
  // todo el mantenimiento; aplicarlo recortaría el renglón de taller de toda la categoría.
  chk("NO es proponible", !a.proponible);
  chk("y NO ocupa `medido`: el chip lo publicaría como «gastado de verdad»", a.medido === null);
  chk("el detalle dice que mide otra cosa", /OTRA COSA|solo el servicio programado/i.test(a.detalle));

  // Un correctivo no tiene periodicidad: dividirlo entre el intervalo le inventaría una.
  const soloCorrectivo = placa([ot({ km: 120000, costo: 900, tipo: "correctivo" })], { intervaloPlanKm: 5000 });
  chk("un correctivo NO se proyecta sobre el intervalo",
    agregarMantenimientoTipo(BUS50, [soloCorrectivo]).plan === null);

  // Una OT abierta por el plan nace en S/ 0.00: contarla partiría el promedio por la mitad.
  const conCero = placa([ot({ km: 120000, costo: 900 }), ot({ fecha: "2026-03-10", km: null, costo: 0 })],
    { intervaloPlanKm: 5000 });
  chk("la orden preventiva en S/ 0.00 no entra al promedio",
    cerca(agregarMantenimientoTipo(BUS50, [conCero]).plan?.soleskm ?? null, 0.18));

  // Una orden preventiva SIN odómetro sí entra: ahí está la gracia del estimado.
  const sinOdometro = placa([ot({ km: null, costo: 900 })], { intervaloPlanKm: 5000 });
  chk("una preventiva sin odómetro también se proyecta",
    agregarMantenimientoTipo(BUS50, [sinOdometro]).plan !== null);

  // Las anuladas y las futuras quedan fuera por donde ya quedaban: la serie.
  const conRuido = placa([
    ot({ km: 120000, costo: 900 }),
    ot({ fecha: "2026-03-10", km: null, costo: 5000, estado: "cancelado" }),
    ot({ fecha: "2026-12-01", km: null, costo: 8000, estado: "pendiente" }),
  ], { intervaloPlanKm: 5000 });
  chk("la anulada y la futura no inflan el estimado",
    cerca(agregarMantenimientoTipo(BUS50, [conRuido]).plan?.soleskm ?? null, 0.18));
}

{
  // SIN INTERVALO, EL COMPORTAMIENTO ES EL DE ANTES, byte a byte. `intervaloPlanKm` es opcional
  // y omitirla no puede cambiar ningún veredicto ya existente.
  for (const ots of [cadena(7), cadena(3), [ot({ km: null, costo: 900 })], []]) {
    const conCampo = agregarMantenimientoTipo(BUS50, [placa(ots, { intervaloPlanKm: null })]);
    const sinCampo = agregarMantenimientoTipo(BUS50, [placa(ots)]);
    chk(`omitir el intervalo no cambia nada (${ots.length} OT)`,
      conCampo.codigo === sinCampo.codigo && conCampo.medido === sinCampo.medido && conCampo.plan === null);
  }

  // Con medición de verdad, el estimado por plan se PUBLICA pero no toca el código: el medido
  // mide lo que hay que medir y manda.
  const conAmbos = agregarMantenimientoTipo(BUS50, [placa(cadena(7), { intervaloPlanKm: 5000 })]);
  chk("con tramos medidos, el medido sigue mandando", conAmbos.codigo === "medido" && conAmbos.proponible);
  chk("y el estimado por plan se publica igual, como evidencia", conAmbos.plan !== null);
}

{
  // Agrupa Σ soles ÷ Σ km, nunca promediando tasas: la unidad con seis servicios registrados no
  // puede pesar lo mismo que la que tiene uno.
  const muchos = placa(Array.from({ length: 6 }, (_, i) =>
    ot({ fecha: `2026-0${i + 1}-10`, km: null, costo: 600 })), { intervaloPlanKm: 5000 });
  const uno = placa([ot({ km: null, costo: 3000 })], { intervaloPlanKm: 5000 });
  const e = estimarPorPlan([muchos, uno]);
  const promedioDeTasas = (600 / 5000 + 3000 / 5000) / 2;
  chk("con dos placas se agrupa, no se promedia",
    e !== null && !cerca(e.soleskm, promedioDeTasas, 0.005), `${e?.soleskm} vs ${promedioDeTasas}`);
  chk("agrupado = 6 600 / 35 000", cerca(e?.soleskm ?? null, 6600 / 35000), `${e?.soleskm}`);

  // Una unidad de tercero no aporta: no se le paga el mantenimiento, se le paga una factura.
  chk("las de tercero no entran al estimado",
    estimarPorPlan([placa([ot({ km: null, costo: 900 })], { flota: "tercero", intervaloPlanKm: 5000 })]) === null);
  // Sin intervalo no hay estimado, y nunca un cero disfrazado.
  chk("sin intervalo no se devuelve nada", estimarPorPlan([placa([ot({ km: null, costo: 900 })])]) === null);
}

// ══ 4 · EL NEUMÁTICO QUE YA SE COBRA APARTE ══════════════════════════════════
console.log("\n4 · EL NEUMÁTICO: se nombra, NO se descuenta solo");

{
  const p = placa([
    ...cadena(7),
    ot({ fecha: "2026-07-15", km: 132000, costo: 9000, descripcion: "Cambio de 6 llantas" }),
  ]);
  const a = agregarMantenimientoTipo(BUS50, [p]);
  chk("bloquea la propuesta", a.codigo === "revisar_neumaticos" && !a.proponible);
  chk("enseña las DOS cifras", a.medido !== null && a.medidoSinNeumaticos !== null,
    `${a.medido} vs ${a.medidoSinNeumaticos}`);
  chk("la de las llantas es la mayor", (a.medido as number) > (a.medidoSinNeumaticos as number));
  chk("el costo de las llantas SIGUE dentro del número publicado",
    (a.medido as number) * a.km > (a.medidoSinNeumaticos as number) * a.km);
  chk("el detalle nombra el doble conteo", /dos veces/i.test(a.detalle));
}

{
  // Lo que NO se afloja: "alineamiento y balanceo" es servicio, no compra de llantas. Si entrara
  // en la lista, media flota quedaría bloqueada para siempre y el chip sería paisaje.
  chk("«alineamiento y balanceo» NO parece compra de llantas",
    !pareceNeumatico("Alineamiento y balanceo de dirección"));
  chk("«cambio de llantas» sí", pareceNeumatico("Cambio de llantas delanteras"));
  chk("«neumáticos» con y sin tilde", pareceNeumatico("Neumáticos nuevos") && pareceNeumatico("Neumaticos traseros"));
}

// ══ 5 · QUIÉN VOTA ═══════════════════════════════════════════════════════════
console.log("\n5 · QUIÉN VOTA: solo las propias; las de tercero HEREDAN");

{
  const propia = placa(cadena(7));
  const tercera = placa([], { flota: "tercero", otsTotales: 0 });
  const a = agregarMantenimientoTipo(BUS50, [propia, tercera]);
  chk("la de tercero no vota", a.aportan.length === 1 && a.aportan[0].uid === propia.uid);
  chk("y se nombra como quien hereda", a.heredan.some((h) => h.flota === "tercero"));
  chk("con una sola propia sí se propone", a.codigo === "medido" && a.proponible);
}

{
  // El reparto por tipo: una placa sin categoría de costeo NO entra a ningún cubo, y nunca al
  // cubo `null` (sería un tipo fantasma que la pantalla tendría que aprender a esconder).
  const mapa = agregarMantenimientoPorTipo(
    [BUS50, { tipo_vehiculo: "BUS_50_ESTANDAR", nombre: "Bus 50 usado", mantenimiento_km: 1.92 }],
    [placa(cadena(7)), placa(cadena(7), { tipoCosteo: null }), placa(cadena(7), { tipoCosteo: "BUS_50_ESTANDAR" })]
  );
  chk("cada tipo recibe solo sus placas",
    mapa.get("BUS_50")!.aportan.length === 1 && mapa.get("BUS_50_ESTANDAR")!.aportan.length === 1);
  chk("la placa sin categoría no aparece en ningún tipo",
    ![...mapa.values()].some((a) => a.aportan.length + a.observadas.length > 1));
}

// ══ 6 · EL CASO QUE MOTIVÓ TODO: premium vs estándar ═════════════════════════
console.log("\n6 · PREMIUM vs ESTÁNDAR: bajar solo la depreciación abarata una mentira");

{
  const PRECIOS = { "Diésel": 24.64, "UREA": 2.50 };
  const premium = {
    tipo_combustible_1: "Diésel", rendimiento_1: 7.5, pct_uso_1: 1,
    tipo_combustible_2: null, rendimiento_2: null, pct_uso_2: null,
    usa_urea: false, consumo_urea_pct: 0.04,
    n_neumaticos: 10, costo_neumatico: 1500, vida_neumatico_km: 65000,
    mantenimiento_km: 1.20,
    valor_compra: 550000, residual_pct: 0.20, vida_util_anios: 10, km_anio: 60000,
    seguro_anual: 33000, soat_anual: 2000, revision_semestral: 750,
    permisos_anual: 9000, otros_fijos_mensual: 0,
  };
  // El error: clonar la premium y tocar SOLO el capital.
  const soloDepreciacion = { ...premium, valor_compra: 137500, residual_pct: 0.30, vida_util_anios: 5 };
  // La ficha honesta: el mismo capital, y además el mantenimiento y el rendimiento de una unidad
  // de más de diez años.
  const honesta = { ...soloDepreciacion, mantenimiento_km: 1.92, rendimiento_1: 6.75 };

  const kmP = costoKmDeParametro(premium, PRECIOS);
  const kmSolo = costoKmDeParametro(soloDepreciacion, PRECIOS);
  const kmHon = costoKmDeParametro(honesta, PRECIOS);

  chk("tocar solo la depreciación ABARATA el S/km", kmSolo < kmP,
    `${kmP.toFixed(4)} → ${kmSolo.toFixed(4)}`);
  chk("y la ficha honesta lo devuelve por encima de la premium", kmHon > kmP,
    `honesta ${kmHon.toFixed(4)} vs premium ${kmP.toFixed(4)}`);
  chk("la diferencia entre las dos estándar no es un detalle (> 10 %)",
    (kmHon - kmSolo) / kmSolo > 0.10, `${(((kmHon - kmSolo) / kmSolo) * 100).toFixed(1)} %`);
}

// ══ 7 · LA EDAD DE LA FLOTA CONTRA SU FICHA ══════════════════════════════════
console.log("\n7 · LA EDAD: el umbral es la vida útil que declara la propia ficha");

{
  const FICHA = { tipo_vehiculo: "BUS_50", vida_util_anios: 10 };
  const conAnio = (anio: number | null) => placa(cadena(2), { anio });

  chk("sin placas → sin_placas",
    cotejarAntiguedadTipo(FICHA, [], 2026).codigo === "sin_placas");
  chk("ninguna con año → sin_anio (NO se afirma que la ficha esté mal)",
    cotejarAntiguedadTipo(FICHA, [conAnio(null)], 2026).codigo === "sin_anio");
  chk("2020 y 2022 con vida 10 → coherente",
    cotejarAntiguedadTipo(FICHA, [conAnio(2020), conAnio(2022)], 2026).codigo === "coherente");
  chk("2009 y 2022 (13 años de brecha ≥ vida 10) → mezcla",
    cotejarAntiguedadTipo(FICHA, [conAnio(2009), conAnio(2022)], 2026).codigo === "mezcla");
  chk("una sola de 2009 (17 años > vida 10) → supera_vida",
    cotejarAntiguedadTipo(FICHA, [conAnio(2009)], 2026).codigo === "supera_vida");

  const mezcla = cotejarAntiguedadTipo(FICHA, [conAnio(2009), conAnio(2022)], 2026);
  chk("la mezcla manda a DUPLICAR la categoría", /duplicar/i.test(mezcla.detalle));
  chk("y avisa de bajar solo la depreciación", /solo la depreciación/i.test(mezcla.detalle));
  chk("el rango se publica", mezcla.minAnio === 2009 && mezcla.maxAnio === 2022 && mezcla.brecha === 13);

  // El umbral sale de la ficha, no de una constante: con vida útil 15 la misma flota es coherente.
  chk("con vida útil 15 la misma brecha ya no es mezcla",
    cotejarAntiguedadTipo({ ...FICHA, vida_util_anios: 15 }, [conAnio(2009), conAnio(2022)], 2026).codigo !== "mezcla");

  // Una unidad sin año no contradice nada, pero se cuenta.
  const conSinAnio = cotejarAntiguedadTipo(FICHA, [conAnio(2020), conAnio(null)], 2026);
  chk("la que no tiene año se cuenta aparte", conSinAnio.sinAnio === 1 && conSinAnio.codigo === "coherente");
}

// ══ 8 · LA MEMORIA DE LA DECISIÓN ════════════════════════════════════════════
console.log("\n8 · EL HISTORIAL: quien escribe y quien lee derivan la clave por el mismo camino");

{
  const a = agregarMantenimientoTipo(BUS50, [placa(cadena(7))]);
  const motivo = motivoHistorialMant(a);
  chk("el motivo de una adopción empieza por «Auto:»", motivo.startsWith("Auto:"), motivo);

  const proc = procedenciaMantDeHistorial([
    { campo_modificado: "mantenimiento_km", valor_nuevo: 1.20, motivo: "Ajuste inflación",
      cambiado_por: "ana@afa.pe", cambiado_en: "2026-01-01T10:00:00Z" },
    { campo_modificado: "mantenimiento_km", valor_nuevo: 0.30, motivo,
      cambiado_por: "jose@afa.pe", cambiado_en: "2026-06-01T10:00:00Z" },
  ]);
  chk("la última con «Auto:» se lee como medida", proc.origen === "medido" && proc.por === "jose@afa.pe");

  const conDescarte = procedenciaMantDeHistorial([
    { campo_modificado: CAMPO_DESCARTE_MANT, valor_nuevo: 0.42, motivo: "Medición revisada y NO adoptada",
      cambiado_por: "jose@afa.pe", cambiado_en: "2026-07-01T10:00:00Z" },
  ]);
  chk("el descarte se recupera del historial", conDescarte.descartado === 0.42);

  // A DIFERENCIA del rendimiento, el sello NO caduca con `tipo_combustible_1`: el mantenimiento
  // medido sigue describiendo a esa flota pase lo que pase con el combustible.
  const trasCambioComb = procedenciaMantDeHistorial([
    { campo_modificado: "mantenimiento_km", valor_nuevo: 0.30, motivo, cambiado_por: "jose@afa.pe", cambiado_en: "2026-06-01T10:00:00Z" },
    { campo_modificado: "tipo_combustible_1", valor_nuevo: null, motivo: "Combustible → GLP", cambiado_por: "ana@afa.pe", cambiado_en: "2026-07-01T10:00:00Z" },
  ]);
  chk("cambiar el combustible NO borra el sello del mantenimiento", trasCambioComb.origen === "medido");
}

// ══ 9 · EL LADO QUE NO SE PUEDE AFLOJAR ══════════════════════════════════════
console.log("\n9 · LO QUE NO SE PUEDE APAGAR SIN QUE NADIE LO NOTE");

{
  // Una medición buena tiene que seguir proponiéndose. Todo lo de arriba RESTRINGE; si algún día
  // esta sección falla, el módulo dejó de servir y la columna sería decorativa.
  const a = agregarMantenimientoTipo(BUS50, [placa(cadena(9, { kmPaso: 6000, costo: 2400 }))]);
  chk("una unidad propia con historial sano SIGUE proponiendo", a.proponible && a.codigo === "medido", a.codigo);
  chk("con su evidencia completa (soles, km y tramos)", a.soles > 0 && a.km > 0 && a.tramos >= MIN_TRAMOS_MANT);
  chk("y con el desvío contra lo tecleado", a.desvio !== null);

  // Un mantenimiento medido MÁS CARO que el tecleado tiene que poder proponerse: es el caso de
  // la unidad usada, y es justo el que este módulo existe para encontrar.
  const caro = agregarMantenimientoTipo(BUS50, [placa(cadena(7, { kmPaso: 5000, costo: 10000 }))]);
  chk("un mantenimiento más caro que el parámetro se propone igual",
    caro.proponible && (caro.medido as number) > BUS50.mantenimiento_km, `${caro.medido} S/km`);
  chk("y su desvío sale positivo", (caro.desvio as number) > 0);
}

console.log(fallos ? `\n❌ ${fallos} fallo(s)` : "\n✅ todo en verde");
process.exit(fallos ? 1 : 0);
