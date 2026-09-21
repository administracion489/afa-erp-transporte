// Matriz de la OCUPACIÓN SEMANAL: embarcados sobre asientos contratados, y cuándo se
// puede proponer una unidad más chica.
// Uso:  npx tsx scripts/prueba-ocupacion-semanal.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · LOS DOS EJEMPLOS DEL DUEÑO, LITERALES. «Si de lunes a sábado embarcaron 12 y el
//     contratado es de 15, no se sugiere cambio porque el vehículo menor es de 10» y
//     «si la contratada es de 30 y embarcaron 23, se sigue ofreciendo la de 30 porque
//     el menor es una Sprinter de 20». Si alguno dejara de salir `no_hay_menor`, el
//     módulo dejó de hacer lo que se le pidió.
//
// 2 · EL PICO, JAMÁS EL PROMEDIO. El caso que lo decide: 12 de lunes a viernes y 28 el
//     sábado. El promedio (~15) cabe en una unidad de 20; el pico no. Se comprueba que
//     el motor NO propone, y —para que la prueba no sea trivial— que el promedio sí
//     habría propuesto: el algoritmo del promedio está escrito aquí al lado.
//
// 3 · UN MANIFIESTO VACÍO NO ES UN CERO. Un servicio con `esperados = 0` no se mide.
//     Si se contara como «viajaron 0», el pico de un bus lleno se hundiría y el ERP
//     propondría encogerlo. Se comprueba con un caso donde los dos comportamientos
//     divergen de forma escandalosa.
//
// 4 · LA INVARIANTE DURA, POR BARRIDO (7 picos × 6 contratados × 4 escaleras × 3
//     márgenes = 504 combinaciones): **jamás se propone una unidad en la que el pico
//     no quepa**, y `propuesta != null ⟺ codigo === "sugiere_cambio"`.
//     Y su corolario, porque un motor que no propusiera nunca cumpliría lo anterior de
//     forma trivial: cuando EXISTE una unidad menor donde el pico cabe, se propone —
//     y es la MÁS CHICA de las que caben.
//
// 5 · LOS CONTADORES SON EXHAUSTIVOS: servicios = cancelados + medidos + sin_manifiesto.
//     Un servicio que no cayera en ninguno sería uno que el reporte no explica.
//
// 6 · `excede_contratado` es el hallazgo que el dueño NO pidió y es el más caro de los
//     dos: alguien viajó de pie o se quedó en el paradero.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const OC = requerir("../lib/ocupacion/semanal") as typeof import("../lib/ocupacion/semanal");

const {
  analizarOcupacion, escaleraDeFlota, motivoOcupacion, rotuloFila,
  ventanaSemanal, hoyLima, esSabadoLima,
  CODIGO_ES_PROPUESTA, CODIGO_ACCIONABLE, ETIQUETA_OCUPACION,
  MARGEN_ASIENTOS, MIN_DIAS_MEDIDOS, MIN_COBERTURA,
} = OC;

type Servicio = import("../lib/ocupacion/semanal").ServicioOcupacion;
type Escalon = import("../lib/ocupacion/semanal").EscalonFlota;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// La flota real de AFA, simplificada a lo que decide: los asientos.
const FLOTA: Escalon[] = [
  { clave: "AUTO_4",     nombre: "Auto 4 pax",      capacidad: 4 },
  { clave: "VAN_10",     nombre: "Van 10 pax",      capacidad: 10 },
  { clave: "HIACE_15",   nombre: "Hiace 15 pax",    capacidad: 15 },
  { clave: "SPRINTER_20", nombre: "Sprinter 20 pax", capacidad: 20 },
  { clave: "MINIBUS_30", nombre: "Minibús 30 pax",  capacidad: 30 },
  { clave: "BUS_50",     nombre: "Bus 50 pax",      capacidad: 50 },
];

/** Construye N días con los embarcados dados. Manifiesto lleno salvo que se diga. */
const dias = (embarcados: number[], opts: Partial<Servicio> = {}): Servicio[] =>
  embarcados.map((e, i) => ({
    reserva_id: 1000 + i,
    fecha: `2026-09-${String(14 + i).padStart(2, "0")}`,
    hora: "06:30",
    ruta_nombre: "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF",
    recorrido: "SANTA ANITA → BSF",
    contratado: 15,
    embarcados: e,
    esperados: Math.max(e, 1),     // manifiesto lleno
    cancelado: false,
    placa: "ABC-123",
    ...opts,
  }));

const unaFila = (ss: Servicio[], flota = FLOTA, cfg = {}) => {
  const f = analizarOcupacion(ss, flota, cfg);
  return f[0];
};

// ── 1 · LOS DOS EJEMPLOS DEL DUEÑO ───────────────────────────────────────────
console.log("\n1 · Los dos ejemplos que dictó el dueño\n");

// «de lunes a sábado embarcaron 12 … el contratado es de 15 … el menor es 10»
const ej1 = unaFila(dias([12, 11, 12, 10, 12, 9]));
chk("12 sobre 15, con la menor en 10 → no se sugiere cambio",
  ej1.codigo === "no_hay_menor", `${ej1.codigo} · pico ${ej1.pico}`);
chk("…y el motivo NOMBRA los dos números y por qué no hay nada en medio",
  /12/.test(motivoOcupacion(ej1)) && /15/.test(motivoOcupacion(ej1)));

// «si la contratada es de 30 y los últimos 7 días embarcaron 23, se sigue
//  ofreciendo la de 30 porque el vehículo menor es una Sprinter de 20»
const ej2 = unaFila(dias([23, 21, 22, 20, 23, 19], { contratado: 30 }));
chk("23 sobre 30, con la Sprinter de 20 debajo → no se sugiere cambio",
  ej2.codigo === "no_hay_menor", `${ej2.codigo} · pico ${ej2.pico}`);

// Y el caso que SÍ tiene que proponer, o el módulo no serviría para nada.
const ej3 = unaFila(dias([9, 8, 10, 7, 9, 8], { contratado: 30 }));
chk("10 sobre 30 → SÍ se propone, y la más chica que cabe (Van 10)",
  ej3.codigo === "sugiere_cambio" && ej3.propuesta?.capacidad === 10,
  `${ej3.codigo} · ${ej3.propuesta?.nombre}`);
chk("…y declara cuántos asientos se liberan y cuánta holgura queda",
  ej3.asientos_liberados === 20 && ej3.asientos_holgura === 0,
  `libera ${ej3.asientos_liberados} · holgura ${ej3.asientos_holgura}`);

// ── 2 · EL PICO, JAMÁS EL PROMEDIO ───────────────────────────────────────────
console.log("\n2 · El pico manda. El promedio dejaría gente en el paradero\n");

/** El algoritmo ingenuo, para probar que los dos DIVERGEN de verdad. */
const propondriaConPromedio = (emb: number[], contratado: number, flota: Escalon[]) => {
  const prom = emb.reduce((a, b) => a + b, 0) / emb.length;
  return escaleraDeFlota(flota).find((e) => e.capacidad >= prom && e.capacidad < contratado) ?? null;
};

// Lunes a viernes 12, sábado 28. Contratado 30.
const SEMANA_PICO = [12, 12, 12, 12, 12, 28];
const pico = unaFila(dias(SEMANA_PICO, { contratado: 30 }));
chk("con 12·5 + 28, el motor NO propone encoger",
  pico.codigo === "no_hay_menor", `${pico.codigo} · pico ${pico.pico}`);
chk("el pico es 28 y nombra el día en que ocurrió",
  pico.pico === 28 && pico.dia_pico === "2026-09-19", `${pico.pico} el ${pico.dia_pico}`);
chk("el promedio se PUBLICA (es útil) pero no decide",
  pico.promedio !== null && pico.promedio < 20, String(pico.promedio));
// Sin esto la prueba sería trivial: hay que demostrar que el promedio SÍ se equivoca.
const conProm = propondriaConPromedio(SEMANA_PICO, 30, FLOTA);
chk("no es trivial: con el promedio se habría propuesto una unidad donde el sábado NO cabe",
  conProm !== null && conProm.capacidad < 28, `${conProm?.nombre} (${conProm?.capacidad}) contra 28 personas`);

// ── 3 · UN MANIFIESTO VACÍO NO ES UN CERO ────────────────────────────────────
console.log("\n3 · Un manifiesto vacío no es «viajaron 0»\n");

// Cuatro días llenos (28) y dos sin manifiesto cargado.
const conHuecos: Servicio[] = [
  ...dias([28, 27, 28, 26], { contratado: 30 }),
  ...dias([0, 0], { contratado: 30 }).map((s, i) => ({ ...s, reserva_id: 9000 + i, fecha: `2026-09-${18 + i}`, esperados: 0 })),
];
const fh = unaFila(conHuecos);
chk("los servicios sin manifiesto NO hunden el pico",
  fh.pico === 28, `pico ${fh.pico}`);
chk("…se cuentan aparte, con su nombre",
  fh.sin_manifiesto === 2 && fh.medidos === 4, `${fh.medidos} medidos · ${fh.sin_manifiesto} sin manifiesto`);
chk("…y con el pico intacto no se propone encoger un bus lleno",
  fh.codigo === "no_hay_menor", fh.codigo);
// La divergencia, para que se vea el tamaño del daño evitado.
const siContaramosElCero = Math.max(...conHuecos.map((s) => s.embarcados));
chk("no es trivial: contando el cero como medición el pico seguiría siendo 28, pero el PROMEDIO caería",
  siContaramosElCero === 28 &&
    conHuecos.reduce((a, s) => a + s.embarcados, 0) / conHuecos.length < 20,
  `promedio contando ceros: ${(conHuecos.reduce((a, s) => a + s.embarcados, 0) / conHuecos.length).toFixed(1)}`);

// Cobertura: con la mayoría sin manifiesto no se juzga.
const casiTodoVacio: Servicio[] = [
  ...dias([9], { contratado: 30 }),
  ...dias([0, 0, 0, 0, 0], { contratado: 30 }).map((s, i) => ({ ...s, reserva_id: 8000 + i, fecha: `2026-09-2${i}`, esperados: 0 })),
];
const cv = unaFila(casiTodoVacio);
chk("con 1 de 6 manifiestos cargados no se propone nada",
  cv.codigo === "cobertura_baja", `${cv.codigo} · cobertura ${cv.cobertura}`);
chk("…y el motivo dice cuántos faltan, que es la tarea",
  /1 de 6/.test(motivoOcupacion(cv)), motivoOcupacion(cv).slice(0, 80));

// Ningún manifiesto en todo el periodo.
const nada = unaFila(dias([0, 0, 0], { contratado: 30, esperados: 0 }));
chk("sin ningún manifiesto: `sin_manifiesto`, y sin pico inventado",
  nada.codigo === "sin_manifiesto" && nada.pico === null, `${nada.codigo} · pico ${nada.pico}`);

// Un solo día medido no es un pico.
const unDia: Servicio[] = [
  ...dias([9], { contratado: 30 }),
  ...dias([0], { contratado: 30 }).map((s) => ({ ...s, reserva_id: 7001, fecha: "2026-09-16", esperados: 0 })),
];
chk("con un solo día medido: `pocos_dias`", unaFila(unDia).codigo === "pocos_dias", unaFila(unDia).codigo);

// ── 4 · CANCELADOS Y EXHAUSTIVIDAD ───────────────────────────────────────────
console.log("\n4 · Un servicio cancelado no se midió: no salió\n");

const conCancelados: Servicio[] = [
  ...dias([12, 11, 12], { contratado: 15 }),
  ...dias([0, 0], { contratado: 15 }).map((s, i) => ({ ...s, reserva_id: 6000 + i, fecha: `2026-09-2${i}`, cancelado: true, esperados: 0 })),
];
const fc = unaFila(conCancelados);
chk("un cancelado no cuenta como «sin manifiesto» (no era suyo llenarlo)",
  fc.cancelados === 2 && fc.sin_manifiesto === 0, `${fc.cancelados} cancelados · ${fc.sin_manifiesto} sin manifiesto`);
chk("la cobertura se mide sobre los PRESTADOS, no sobre el total",
  fc.cobertura === 1, String(fc.cobertura));

// ── 5 · `excede_contratado`, el hallazgo que no se pidió ─────────────────────
console.log("\n5 · Cuando el pico SUPERA lo contratado\n");

const exceso = unaFila(dias([28, 30, 32, 29, 28, 27], { contratado: 30 }));
chk("32 personas sobre 30 asientos contratados → `excede_contratado`",
  exceso.codigo === "excede_contratado", exceso.codigo);
chk("…el motivo dice cuántas por encima y en qué día",
  /2 por encima/.test(motivoOcupacion(exceso)) && /2026-09-16/.test(motivoOcupacion(exceso)),
  motivoOcupacion(exceso).slice(0, 90));
chk("…y NO es una propuesta comercial (no se le ofrece al cliente pagar menos)",
  CODIGO_ES_PROPUESTA.excede_contratado === false && CODIGO_ACCIONABLE.excede_contratado === true);
chk("solo `sugiere_cambio` es propuesta comercial",
  Object.entries(CODIGO_ES_PROPUESTA).filter(([, v]) => v).map(([k]) => k).join(",") === "sugiere_cambio");

// ── 6 · SIN CONTRATADO Y SIN FLOTA ───────────────────────────────────────────
console.log("\n6 · Lo que no se puede juzgar se NOMBRA\n");

const sinCont = unaFila(dias([12, 11, 12], { contratado: null }));
chk("sin asientos contratados: `sin_contratado`", sinCont.codigo === "sin_contratado", sinCont.codigo);
chk("…pero el pico SÍ se publica (es el dato que ya se tiene)", sinCont.pico === 12, String(sinCont.pico));
chk("…y NUNCA se cae a la capacidad del vehículo asignado",
  sinCont.contratado === null && sinCont.propuesta === null);

const sinFlota = unaFila(dias([9, 8, 9], { contratado: 30 }), []);
chk("sin flota declarada no se inventa una unidad", sinFlota.codigo === "sin_flota" && sinFlota.propuesta === null,
  sinFlota.codigo);

// ── 7 · LA ESCALERA ──────────────────────────────────────────────────────────
console.log("\n7 · La escalera sale de la flota\n");

const conGemelas = escaleraDeFlota([
  ...FLOTA,
  { clave: "SPRINTER_20_ESTANDAR", nombre: "Sprinter 20 pax · Estándar", capacidad: 20 },
  { clave: "ROTA", nombre: "Ficha sin capacidad", capacidad: 0 },
]);
chk("dos fichas de la misma capacidad son UN escalón (deciden los asientos, no la ficha)",
  conGemelas.filter((e) => e.capacidad === 20).length === 1, `${conGemelas.length} escalones`);
chk("una capacidad en 0 no entra (el cotizador no ofrece «0 pax»)",
  conGemelas.every((e) => e.capacidad > 0));
chk("queda ordenada de menor a mayor",
  conGemelas.every((e, i, a) => i === 0 || a[i - 1].capacidad < e.capacidad),
  conGemelas.map((e) => e.capacidad).join(" · "));

// ── 8 · EL BARRIDO ───────────────────────────────────────────────────────────
console.log("\n8 · Barrido: nunca se propone una unidad donde el pico no quepa\n");

const ESCALERAS: Escalon[][] = [
  FLOTA,
  [],
  [{ clave: "A", nombre: "Solo bus", capacidad: 50 }],
  [
    { clave: "A", nombre: "A", capacidad: 12 }, { clave: "B", nombre: "B", capacidad: 16 },
    { clave: "C", nombre: "C", capacidad: 24 }, { clave: "D", nombre: "D", capacidad: 25 },
    { clave: "E", nombre: "E", capacidad: 31 },
  ],
];
const PICOS = [1, 4, 9, 12, 20, 23, 28];
const CONTRATADOS = [4, 10, 15, 20, 30, 50];
const MARGENES = [0, 2, 5];

let combos = 0, propuestasMalas = 0, incoherentes = 0, noMasChica = 0, perdidas = 0, propuestas = 0, contadoresMal = 0;

for (const esc of ESCALERAS) {
  for (const p of PICOS) {
    for (const c of CONTRATADOS) {
      for (const m of MARGENES) {
        combos++;
        // Tres días medidos, con el pico en el del medio.
        const f = unaFila(dias([Math.max(1, p - 2), p, Math.max(1, p - 1)], { contratado: c }), esc, { margenAsientos: m });

        // (a) propuesta != null  ⟺  sugiere_cambio
        if ((f.propuesta !== null) !== (f.codigo === "sugiere_cambio")) incoherentes++;

        // (b) LA INVARIANTE DURA: si se propone, el pico CABE con su margen,
        //     y la propuesta es de verdad más chica que lo contratado.
        if (f.propuesta) {
          propuestas++;
          if (f.propuesta.capacidad < p + m || f.propuesta.capacidad >= c) propuestasMalas++;
          // (c) …y es la MÁS CHICA de las que caben.
          const caben = escaleraDeFlota(esc).filter((e) => e.capacidad >= p + m && e.capacidad < c);
          if (caben.length && f.propuesta.capacidad !== caben[0].capacidad) noMasChica++;
        } else if (f.codigo === "no_hay_menor" || f.codigo === "ya_es_la_menor") {
          // (d) EL COROLARIO: si NO se propuso pero existía una que cabía, se perdió
          //     una recomendación buena — un motor que nunca propone es inútil.
          const caben = escaleraDeFlota(esc).filter((e) => e.capacidad >= p + m && e.capacidad < c);
          if (caben.length > 0) perdidas++;
        }

        // (e) Los contadores son exhaustivos.
        if (f.servicios !== f.cancelados + f.medidos + f.sin_manifiesto) contadoresMal++;
      }
    }
  }
}

chk(`${combos} combinaciones · propuesta != null ⟺ sugiere_cambio`, incoherentes === 0, `${incoherentes} fallos`);
chk(`${combos} combinaciones · JAMÁS se propone una unidad donde el pico no quepa`, propuestasMalas === 0, `${propuestasMalas} fallos`);
chk(`${combos} combinaciones · siempre se propone la MÁS CHICA que cabe`, noMasChica === 0, `${noMasChica} fallos`);
chk(`${combos} combinaciones · no se pierde ninguna recomendación buena`, perdidas === 0, `${perdidas} fallos`);
chk(`${combos} combinaciones · servicios = cancelados + medidos + sin manifiesto`, contadoresMal === 0, `${contadoresMal} fallos`);
chk("no es trivial: el barrido produjo propuestas de verdad", propuestas > 20, `${propuestas} propuestas`);

// Todo código tiene etiqueta y motivo: un código sin texto imprime el código crudo.
const CODIGOS = Object.keys(ETIQUETA_OCUPACION) as (keyof typeof ETIQUETA_OCUPACION)[];
chk("todo código tiene etiqueta, y las tres tablas cubren los mismos códigos",
  CODIGOS.every((c) => !!ETIQUETA_OCUPACION[c])
  && CODIGOS.every((c) => c in CODIGO_ES_PROPUESTA && c in CODIGO_ACCIONABLE)
  && Object.keys(CODIGO_ES_PROPUESTA).length === CODIGOS.length,
  `${CODIGOS.length} códigos`);

// ── 9 · LA VENTANA Y LA FECHA PERUANA ────────────────────────────────────────
console.log("\n9 · La ventana de 7 días y la hora de Perú\n");

const v = ventanaSemanal("2026-09-19");
chk("los 7 días que cierran el sábado 19 arrancan el domingo 13",
  v.inicio === "2026-09-13" && v.fin === "2026-09-19", `${v.inicio} → ${v.fin}`);
// 2026-09-20 05:00 UTC son las 00:00 del sábado 19 en Lima.
chk("a las 00:00 del sábado en Lima (05:00 UTC del domingo) sigue siendo sábado 19",
  hoyLima(Date.parse("2026-09-20T04:59:00Z")) === "2026-09-19"
  && esSabadoLima(Date.parse("2026-09-20T04:59:00Z")) === true);
chk("…y un minuto después ya es domingo 20",
  hoyLima(Date.parse("2026-09-20T05:01:00Z")) === "2026-09-20"
  && esSabadoLima(Date.parse("2026-09-20T05:01:00Z")) === false);

// ── 10 · EL RÓTULO NO INVENTA UN NOMBRE ──────────────────────────────────────
console.log("\n10 · Una ruta sin nombre se dice, no se rellena\n");

const sinNombre = unaFila(dias([9, 8, 9], { ruta_nombre: null, contratado: 30 }));
chk("sin nombre, `ruta_nombre` sigue en null (no se cae al recorrido)", sinNombre.ruta_nombre === null);
chk("…y el rótulo lo DICE, conservando el recorrido para distinguirla",
  rotuloFila(sinNombre) === "Sin nombre · SANTA ANITA → BSF", rotuloFila(sinNombre));

// Dos rutas escritas distinto salen en dos filas: partir es el error seguro.
const dosRedacciones = analizarOcupacion(
  [...dias([9, 8, 9], { contratado: 30 }),
   ...dias([28, 27, 28], { contratado: 30, ruta_nombre: "RUTA A / ENTRADA 06:35 / SANTA ANITA→BSF" })],
  FLOTA);
chk("dos redacciones de la misma ruta salen en DOS filas (partir es el error seguro)",
  dosRedacciones.length === 2, `${dosRedacciones.length} filas`);
chk("…así ninguna hereda el pico de la otra",
  dosRedacciones.some((f) => f.pico === 9) && dosRedacciones.some((f) => f.pico === 28));

// Y dos capacidades contratadas distintas nunca se funden en una fila.
const dosCapacidades = analizarOcupacion(
  [...dias([9, 8, 9], { contratado: 10 }), ...dias([9, 8, 9], { contratado: 30 })], FLOTA);
chk("dos capacidades contratadas de la misma ruta son DOS filas",
  dosCapacidades.length === 2, `${dosCapacidades.length} filas`);

// ── 11 · LOS UMBRALES ESTÁN DECLARADOS ───────────────────────────────────────
console.log("\n11 · Los umbrales\n");
chk("el margen por defecto es 0: es la regla literal del dueño, no un número prudente",
  MARGEN_ASIENTOS === 0);
chk("un pico necesita al menos dos días", MIN_DIAS_MEDIDOS >= 2, String(MIN_DIAS_MEDIDOS));
chk("la cobertura mínima es la mayoría", MIN_COBERTURA >= 0.5, String(MIN_COBERTURA));

// ── Cierre ────────────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
