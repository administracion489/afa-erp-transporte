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
//
// 7 · LA IDA Y SU RETORNO SON UN SOLO SERVICIO (sección 13). Lo reportó el dueño sobre
//     el correo real: «debería decir 1 ruta con 17 servicios». Se fija el conteo, pero
//     sobre todo el DAÑO que evita — con las filas separadas, el retorno de una ruta de
//     50 asientos que movió 20 personas proponía por su cuenta «cabe en una unidad
//     menor» sobre un bus que por la mañana va con 34. El algoritmo VIEJO está copiado
//     literal al lado para probar que reproduce ese defecto, y que sin `hermano_id` el
//     resultado sigue siendo byte a byte el de antes.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const OC = requerir("../lib/ocupacion/semanal") as typeof import("../lib/ocupacion/semanal");

const {
  analizarOcupacion, escaleraDeFlota, emparejarDias,
  motivoOcupacion, motivoSinRecomendacion, rotuloFila,
  ventanaSemanal, hoyLima, esSabadoLima,
  CODIGO_RECOMIENDA, ETIQUETA_RECOMIENDA, CODIGO_ACCIONABLE, ETIQUETA_OCUPACION,
  MARGEN_ASIENTOS, MIN_DIAS_MEDIDOS, MIN_COBERTURA,
} = OC;
const CAD = requerir("../lib/ocupacion/cadencia") as typeof import("../lib/ocupacion/cadencia");
const {
  tocaHoy, ventanaDe, normalizarFrecuencia, normalizarVentana,
  describirCadencia, avisoCadencia, FRECUENCIAS, VENTANAS, diasDelMes, restarDias,
} = CAD;

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
// Los DOS sentidos son una recomendación y la casilla los calla a los dos: el dueño
// lo pidió como «que el cliente analice su flota y nosotros no le hagamos ninguna
// sugerencia». Pero la ETIQUETA de `excede_contratado` es un HECHO y se conserva:
// callar que 32 personas viajaron sobre 30 asientos es lo único que no se puede hacer.
chk("recomiendan los DOS sentidos: bajar y subir de unidad",
  CODIGO_RECOMIENDA.sugiere_cambio === true && CODIGO_RECOMIENDA.excede_contratado === true &&
  Object.entries(CODIGO_RECOMIENDA).filter(([, v]) => v).length === 2);
chk("…pero solo la etiqueta de `sugiere_cambio` es en sí una propuesta",
  ETIQUETA_RECOMIENDA.sugiere_cambio === true && ETIQUETA_RECOMIENDA.excede_contratado === false);
chk("el motivo sin recomendación CONSERVA los números y suelta la conclusión",
  (() => {
    const n = motivoSinRecomendacion(exceso)!;
    return /32/.test(n) && /30/.test(n) && !/conviene/i.test(n);
  })(), motivoSinRecomendacion(exceso) ?? "null");
chk("…y en `sugiere_cambio` tampoco nombra la unidad propuesta",
  (() => {
    const n = motivoSinRecomendacion(ej3)!;
    return /10/.test(n) && /30/.test(n) && !/Van/.test(n) && !/cabr/i.test(n);
  })(), motivoSinRecomendacion(ej3) ?? "null");
chk("los códigos que no recomiendan no reescriben su motivo",
  motivoSinRecomendacion(ej1) === null && motivoSinRecomendacion(nada) === null);

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
// Las CUATRO tablas cubren exactamente los mismos códigos: una que se quedara corta
// dejaría un código sin juzgar y la pantalla imprimiría el código crudo.
chk("todo código tiene etiqueta, y las cuatro tablas cubren los mismos códigos",
  CODIGOS.every((c) => !!ETIQUETA_OCUPACION[c])
  && CODIGOS.every((c) => c in CODIGO_RECOMIENDA && c in ETIQUETA_RECOMIENDA && c in CODIGO_ACCIONABLE)
  && Object.keys(CODIGO_RECOMIENDA).length === CODIGOS.length
  && Object.keys(ETIQUETA_RECOMIENDA).length === CODIGOS.length
  && Object.keys(CODIGO_ACCIONABLE).length === CODIGOS.length,
  `${CODIGOS.length} códigos`);
// Una etiqueta que recomienda implica que el motivo también: al revés sí puede pasar
// (`excede_contratado` tiene etiqueta de hecho y motivo con recomendación).
chk("si la etiqueta recomienda, el motivo también",
  CODIGOS.every((c) => !ETIQUETA_RECOMIENDA[c] || CODIGO_RECOMIENDA[c]));

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

// ── 12 · LA CADENCIA: CADA CUÁNTO Y CUÁNTO ABARCA ────────────────────────────
console.log("\n12 · Cada cuánto se manda y cuánto periodo abarca son DOS ejes\n");

// Todo 2026, día por día. Es el barrido que descubre los meses de 28, 29, 30 y 31.
const DIAS_2026: string[] = [];
for (let m = 1; m <= 12; m++) {
  for (let d = 1; d <= diasDelMes(2026, m); d++) {
    DIAS_2026.push(`2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
}
chk("el año se arma con 365 días (2026 no es bisiesto)", DIAS_2026.length === 365, `${DIAS_2026.length}`);

const cuenta = (f: any) => DIAS_2026.filter((d) => tocaHoy(f, d)).length;
chk("semanal → 52 sábados", cuenta("semanal") === 52, `${cuenta("semanal")}`);
chk("quincenal → 24 envíos (día 1 y 16 de cada mes)", cuenta("quincenal") === 24, `${cuenta("quincenal")}`);
chk("mensual → 12 envíos (día 1)", cuenta("mensual") === 12, `${cuenta("mensual")}`);
chk("fin de mes → 12 envíos, y acierta en los meses de 28, 30 y 31",
  cuenta("fin_de_mes") === 12
  && tocaHoy("fin_de_mes", "2026-02-28") && !tocaHoy("fin_de_mes", "2026-02-27")
  && tocaHoy("fin_de_mes", "2026-04-30") && !tocaHoy("fin_de_mes", "2026-04-29")
  && tocaHoy("fin_de_mes", "2026-12-31"),
  `${cuenta("fin_de_mes")}`);

// LA VENTANA `mes` ES EL ÚLTIMO MES COMPLETO, y esa es la definición que hace
// coherentes las cuatro frecuencias. Sin ella, «mensual + mes calendario» habría
// mandado un reporte de 24 horas.
const vMes = (f: string) => ventanaDe("mes", f);
chk("fin de mes → el mes que acaba de cerrar",
  JSON.stringify(vMes("2026-09-30")) === JSON.stringify({ inicio: "2026-09-01", fin: "2026-09-30" }),
  JSON.stringify(vMes("2026-09-30")));
chk("día 1 → el mes anterior COMPLETO, no un día suelto",
  JSON.stringify(vMes("2026-10-01")) === JSON.stringify({ inicio: "2026-09-01", fin: "2026-09-30" }),
  JSON.stringify(vMes("2026-10-01")));
chk("a mitad de mes → el último completo, nunca medio mes en curso",
  JSON.stringify(vMes("2026-10-15")) === JSON.stringify({ inicio: "2026-09-01", fin: "2026-09-30" }),
  JSON.stringify(vMes("2026-10-15")));
chk("cruza el año sin romperse",
  JSON.stringify(vMes("2027-01-01")) === JSON.stringify({ inicio: "2026-12-01", fin: "2026-12-31" }),
  JSON.stringify(vMes("2027-01-01")));
chk("febrero sale con sus 28 días, no con 30",
  JSON.stringify(vMes("2026-03-01")) === JSON.stringify({ inicio: "2026-02-01", fin: "2026-02-28" }),
  JSON.stringify(vMes("2026-03-01")));

// Barrido: la ventana `mes` SIEMPRE es un mes completo y SIEMPRE ya cerró.
let mesMal = 0;
for (const d of DIAS_2026) {
  const v = vMes(d);
  const [ai, mi, di] = v.inicio.split("-").map(Number);
  const [af, mf, df] = v.fin.split("-").map(Number);
  if (di !== 1) mesMal++;                                   // arranca el día 1
  if (ai !== af || mi !== mf) mesMal++;                     // mismo mes en los dos extremos
  if (df !== diasDelMes(af, mf)) mesMal++;                  // termina el último día
  if (v.fin > d) mesMal++;                                  // ya cerró en o antes de `fin`
}
chk(`${DIAS_2026.length} días · la ventana «mes» es siempre un mes COMPLETO y ya cerrado`,
  mesMal === 0, `${mesMal} fallos`);

// Las ventanas por días: N días exactos, cerrando en `fin`.
let diasMal = 0;
for (const d of DIAS_2026) {
  for (const n of ["7", "15", "30"] as const) {
    const v = ventanaDe(n, d);
    if (v.fin !== d) diasMal++;
    if (v.inicio !== restarDias(d, Number(n) - 1)) diasMal++;
  }
}
chk(`${DIAS_2026.length * 3} ventanas · 7/15/30 días cierran EXACTAMENTE en el día del envío`,
  diasMal === 0, `${diasMal} fallos`);

// Un valor desconocido cae al DEFECTO, nunca apaga el reporte de nadie.
chk("sin migración (undefined) el comportamiento es el de siempre: sábados con 7 días",
  normalizarFrecuencia(undefined) === "semanal" && normalizarVentana(undefined) === "7");
chk("un valor corrupto tampoco apaga a nadie",
  normalizarFrecuencia("cada-luna-llena") === "semanal" && normalizarVentana("99") === "7");
chk("todas las claves del catálogo se normalizan a sí mismas",
  FRECUENCIAS.every((f) => normalizarFrecuencia(f.clave) === f.clave)
  && VENTANAS.every((v) => normalizarVentana(v.clave) === v.clave));

// La frase de pantalla se DERIVA de los mismos valores que usa el motor.
let fraseMal = 0;
for (const f of FRECUENCIAS) {
  for (const v of VENTANAS) {
    const t = describirCadencia(f.clave, v.clave);
    if (!t.startsWith("Se envía") || !t.endsWith(".")) fraseMal++;
    // Nombra el periodo con el mismo número que la ventana, no con otro.
    if (v.clave !== "mes" && !t.includes(`${v.clave} días`)) fraseMal++;
    if (v.clave === "mes" && !/mes calendario/.test(t)) fraseMal++;
  }
}
chk(`${FRECUENCIAS.length * VENTANAS.length} combinaciones · la frase describe la configuración real`,
  fraseMal === 0, `${fraseMal} fallos`);

// El aviso sale EXACTAMENTE donde dos envíos del mismo mes piden el mismo periodo.
chk("avisa en semanal + mes calendario (varios envíos piden el mismo periodo)",
  avisoCadencia("semanal", "mes") !== null && avisoCadencia("quincenal", "mes") !== null);
chk("…y NO avisa donde cada envío pide un periodo distinto",
  avisoCadencia("mensual", "mes") === null && avisoCadencia("fin_de_mes", "mes") === null
  && FRECUENCIAS.every((f) => (["7", "15", "30"] as const).every((v) => avisoCadencia(f.clave, v) === null)));

// Y LA RAZÓN DEL AVISO TIENE QUE SER CIERTA. La primera redacción prometía «solo
// saldrá el primero de cada mes» y este barrido la desmintió: cuando el último día
// del mes cae sábado, ESE envío pide su propio mes y también sale. Lo que sí es
// cierto —y es lo único que el aviso promete ahora— es que sale UNO por periodo.
const sabados2026 = DIAS_2026.filter((d) => tocaHoy("semanal", d));
const periodos2026 = new Set(sabados2026.map((d) => vMes(d).fin));
chk("el aviso no miente: 52 envíos semanales con ventana «mes» caen en un puñado de periodos",
  sabados2026.length === 52 && periodos2026.size <= 13 && periodos2026.size >= 12,
  `${sabados2026.length} envíos → ${periodos2026.size} periodo(s) distintos`);
chk("…y ningún envío queda sin periodo (cada sábado pide uno, aunque se repita)",
  sabados2026.every((d) => !!vMes(d).fin));
// El caso que desmintió la primera redacción, conservado: el 31-10-2026 es sábado.
chk("un sábado que además es el último día del mes pide SU mes, no el anterior",
  tocaHoy("semanal", "2026-10-31") && vMes("2026-10-31").inicio === "2026-10-01",
  JSON.stringify(vMes("2026-10-31")));

// La compatibilidad: la ventana de siempre sigue siendo la de 7 días.
chk("ventanaSemanal ≡ ventanaDe(\"7\")",
  JSON.stringify(ventanaSemanal("2026-09-19")) === JSON.stringify(ventanaDe("7", "2026-09-19")));

// ── 13 · LA IDA Y SU RETORNO SON UN SOLO SERVICIO ────────────────────────────
console.log("\n13 · La ida y su retorno son UN servicio de UNA ruta\n");

/**
 * EL AGRUPADOR VIEJO, COPIADO LITERAL: una fila por TRAMO. Está aquí para que la
 * prueba no sea trivial — hay que demostrar que el defecto existía y que el arreglo
 * lo quita, no solo que el código nuevo hace algo.
 */
const claveVIEJA = (s: Servicio) => {
  const n = String(s.ruta_nombre ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  const identidad = n || `«${String(s.recorrido ?? "").trim().toUpperCase()}»`;
  return `${identidad}|${s.contratado ?? "?"}`;
};
const gruposVIEJOS = (ss: Servicio[]) => {
  const m = new Map<string, Servicio[]>();
  for (const s of ss) {
    if (!s.fecha) continue;
    const k = claveVIEJA(s);
    m.set(k, [...(m.get(k) ?? []), s]);
  }
  return m;
};

/** Un día de contrato: la ida y su retorno, enlazados por los DOS lados. */
let idSec = 0;
const dia = (
  fecha: string, embIda: number, embRet: number,
  opts: { contratado?: number | null; ida?: string; retorno?: string; enlace?: "mutuo" | "suelto";
          canceladaIda?: boolean; canceladaRet?: boolean; espIda?: number; espRet?: number } = {},
): Servicio[] => {
  const a = 5000 + (idSec += 2), b = a + 1;
  const mutuo = (opts.enlace ?? "mutuo") === "mutuo";
  const base = {
    fecha, recorrido: "SANTA ANITA → BSF", contratado: opts.contratado === undefined ? 50 : opts.contratado,
    placa: "B8H-967",
  };
  return [
    { ...base, reserva_id: a, hora: "06:35", ruta_nombre: opts.ida ?? "RUTA C/ ENTRADA 06:35",
      sentido: "IDA" as const, embarcados: embIda, esperados: opts.espIda ?? Math.max(embIda, 1),
      cancelado: !!opts.canceladaIda, hermano_id: mutuo ? b : null },
    { ...base, reserva_id: b, hora: "17:00", ruta_nombre: opts.retorno ?? "RUTA C/ RETORNO 17:00",
      sentido: "RETORNO" as const, embarcados: embRet, esperados: opts.espRet ?? Math.max(embRet, 1),
      cancelado: !!opts.canceladaRet, hermano_id: mutuo ? a : null },
  ];
};

// EL CASO REPORTADO. Seis días de contrato = 12 tramos = 1 ruta, 6 servicios.
const contrato = [
  ...dia("2026-09-14", 34, 20), ...dia("2026-09-15", 33, 19), ...dia("2026-09-16", 34, 20),
  ...dia("2026-09-17", 32, 18), ...dia("2026-09-18", 34, 20), ...dia("2026-09-19", 33, 19),
];
const fc1 = analizarOcupacion(contrato, FLOTA);
chk("12 tramos de ida y retorno son 1 RUTA, no dos",
  fc1.length === 1, `${fc1.length} filas`);
chk("…y 6 SERVICIOS, no 12 (es lo que reportó el dueño)",
  fc1[0].servicios === 6 && fc1[0].tramos === 12,
  `${fc1[0].servicios} servicios · ${fc1[0].tramos} tramos`);
chk("el rótulo imprime los DOS nombres, ida y retorno",
  rotuloFila(fc1[0]) === "RUTA C/ ENTRADA 06:35 ⇄ RUTA C/ RETORNO 17:00", rotuloFila(fc1[0]));

// EL PICO DEL DÍA ES EL MÁXIMO, JAMÁS LA SUMA.
chk("el pico del día es el MÁXIMO de sus tramos (34), nunca la suma (54)",
  fc1[0].pico === 34, `pico ${fc1[0].pico}`);
chk("no es trivial: sumando los dos tramos el pico sería 54 sobre 50 asientos",
  34 + 20 > 50);
const sumando = analizarOcupacion(contrato, FLOTA).length && (34 + 20);
chk("…y ese 54 habría puesto una ruta que nunca se llenó en `excede_contratado`",
  sumando > 50 && fc1[0].codigo !== "excede_contratado", fc1[0].codigo);

// EL DAÑO QUE EVITA, Y ES EL MOTIVO DEL CAMBIO.
const viejo = [...gruposVIEJOS(contrato).entries()].map(([k, ss]) =>
  analizarOcupacion(ss, FLOTA)[0]);
chk("con el agrupador VIEJO salían DOS filas para la misma ruta",
  gruposVIEJOS(contrato).size === 2, `${gruposVIEJOS(contrato).size} filas`);
chk("…y el RETORNO proponía por su cuenta encoger un bus que por la mañana lleva 34",
  viejo.some((f) => f.codigo === "sugiere_cambio" && f.pico === 20),
  viejo.map((f) => `${f.pico}→${f.codigo}`).join(" · "));
chk("con el día entero, la ruta NO se encoge", fc1[0].codigo === "no_hay_menor", fc1[0].codigo);

// LA OTRA MITAD DE LO QUE PIDIÓ EL DUEÑO: «son rutas diferentes si son horarios
// diferentes sin ser hermanos».
const dosHorarios = analizarOcupacion([
  ...dia("2026-09-14", 34, 20), ...dia("2026-09-15", 33, 19),
  ...dia("2026-09-14", 12, 9, { ida: "RUTA C/ ENTRADA 05:10", retorno: "RUTA C/ RETORNO 15:00" }),
  ...dia("2026-09-15", 11, 8, { ida: "RUTA C/ ENTRADA 05:10", retorno: "RUTA C/ RETORNO 15:00" }),
], FLOTA);
chk("dos horarios distintos que NO son hermanos siguen siendo DOS rutas",
  dosHorarios.length === 2, `${dosHorarios.length} filas`);
chk("…y ninguna hereda el pico de la otra",
  dosHorarios.some((f) => f.pico === 34) && dosHorarios.some((f) => f.pico === 12),
  dosHorarios.map((f) => f.pico).join(" · "));

// UN TRAMO SIN MANIFIESTO NO HUNDE AL DÍA (la decisión 2, aplicada al día).
const conRetornoVacio = analizarOcupacion([
  ...dia("2026-09-14", 34, 0, { espRet: 0 }),
  ...dia("2026-09-15", 33, 0, { espRet: 0 }),
  ...dia("2026-09-16", 34, 0, { espRet: 0 }),
], FLOTA);
chk("un retorno sin manifiesto NO deja el día sin medir",
  conRetornoVacio[0].medidos === 3 && conRetornoVacio[0].sin_manifiesto === 0,
  `${conRetornoVacio[0].medidos} medidos · ${conRetornoVacio[0].sin_manifiesto} sin manifiesto`);
chk("…y el pico del día es el del tramo que SÍ se midió",
  conRetornoVacio[0].pico === 34, `pico ${conRetornoVacio[0].pico}`);

// EL DÍA SE CANCELA SOLO SI SE CAYERON LOS DOS.
const medioCaido = analizarOcupacion([
  ...dia("2026-09-14", 0, 20, { canceladaIda: true, espIda: 0 }),
  ...dia("2026-09-15", 0, 19, { canceladaIda: true, espIda: 0 }),
  ...dia("2026-09-16", 0, 0, { canceladaIda: true, canceladaRet: true, espIda: 0, espRet: 0 }),
], FLOTA);
chk("con la ida cancelada y el retorno prestado, el día NO está cancelado",
  medioCaido[0].cancelados === 1 && medioCaido[0].medidos === 2,
  `${medioCaido[0].cancelados} cancelados · ${medioCaido[0].medidos} medidos`);

// UN ENLACE QUE NO ES MUTUO NO EMPAREJA: adivinar sería medir dos días como uno.
const treParaUno = [
  ...dia("2026-09-14", 34, 20),                       // A ⇄ B, mutuo
  { ...dia("2026-09-14", 12, 9)[0], reserva_id: 9001, hermano_id: 5002 }, // C → B, sin vuelta
];
const dTres = emparejarDias(treParaUno as Servicio[]);
chk("un tercer tramo que reclama un hermano ya emparejado se queda SOLO",
  dTres.length === 2 && dTres.some((d) => d.tramos.length === 2) && dTres.some((d) => d.tramos.length === 1),
  dTres.map((d) => d.tramos.length).join(" · "));

const noReciproco = emparejarDias([
  { ...dia("2026-09-14", 34, 20)[0], hermano_id: 7002 },
  { ...dia("2026-09-14", 20, 0)[1], reserva_id: 7002, hermano_id: 7999 },
] as Servicio[]);
chk("un enlace que apunta a otro sitio no empareja nada",
  noReciproco.length === 2, `${noReciproco.length} días`);

// UN DÍA AL QUE LE FALTA UN TRAMO NO ES OTRA RUTA — pero solo sin ambigüedad.
const conSuelto = analizarOcupacion([
  ...dia("2026-09-14", 34, 20), ...dia("2026-09-15", 33, 19), ...dia("2026-09-16", 34, 20),
  // El 17 se borró el retorno: la ida llega sola y sin enlace.
  { ...dia("2026-09-17", 32, 0)[0], hermano_id: null },
], FLOTA);
chk("una ida suelta se suma al grupo de su ruta (hay UN solo candidato)",
  conSuelto.length === 1 && conSuelto[0].servicios === 4 && conSuelto[0].tramos === 7,
  `${conSuelto.length} filas · ${conSuelto[0]?.servicios} servicios · ${conSuelto[0]?.tramos} tramos`);

// Y un RETORNO suelto absorbido no puede rotular la columna de la IDA con su
// nombre: el rótulo sale de los días COMPLETOS cuando los hay.
const retornoSuelto = analizarOcupacion([
  ...dia("2026-09-14", 34, 20), ...dia("2026-09-15", 33, 19),
  { ...dia("2026-09-17", 0, 30)[1], hermano_id: null },
], FLOTA);
chk("un retorno suelto se absorbe sin ensuciar el nombre de la ida",
  retornoSuelto.length === 1
  && retornoSuelto[0].ruta_nombre === "RUTA C/ ENTRADA 06:35"
  && retornoSuelto[0].ruta_retorno === "RUTA C/ RETORNO 17:00"
  && retornoSuelto[0].servicios === 3,
  `${rotuloFila(retornoSuelto[0])} · ${retornoSuelto[0].servicios} servicios`);

const sueltoAmbiguo = analizarOcupacion([
  ...dia("2026-09-14", 34, 20), ...dia("2026-09-15", 33, 19),
  // Otra ruta que comparte el nombre de la ida, con otro retorno.
  ...dia("2026-09-14", 12, 9, { retorno: "RUTA C/ RETORNO 15:00" }),
  ...dia("2026-09-15", 11, 8, { retorno: "RUTA C/ RETORNO 15:00" }),
  { ...dia("2026-09-17", 32, 0)[0], hermano_id: null },
], FLOTA);
chk("con DOS candidatos la suelta se queda aparte: adivinar le metería el pico de otra",
  sueltoAmbiguo.length === 3, `${sueltoAmbiguo.length} filas`);

// SIN `hermano_id` EL COMPORTAMIENTO ES BYTE A BYTE EL ANTERIOR.
const sinEnlace = contrato.map((s) => ({ ...s, hermano_id: null }));
const fSin = analizarOcupacion(sinEnlace, FLOTA);
const vSin = gruposVIEJOS(sinEnlace);
chk("sin enlace escrito, la agrupación es EXACTAMENTE la vieja (una fila por tramo)",
  fSin.length === vSin.size
  && fSin.every((f) => f.tramos === f.servicios)
  && [...vSin.values()].every((ss) => fSin.some((f) => f.servicios === ss.length)),
  `${fSin.length} filas contra ${vSin.size} del viejo`);
chk("…y el retorno vuelve a proponer encoger el bus — el defecto reaparece sin el dato",
  fSin.some((f) => f.codigo === "sugiere_cambio"),
  fSin.map((f) => `${f.pico}→${f.codigo}`).join(" · "));

// ── EL BARRIDO DEL EMPAREJAMIENTO ────────────────────────────────────────────
console.log("\n13b · Barrido: no se pierde ni se duplica ningún tramo\n");

const ENLACES = ["mutuo", "suelto"] as const;
const EMB_IDA = [0, 12, 34];
const EMB_RET = [0, 20, 30];
const CANCELA: [boolean, boolean][] = [[false, false], [true, false], [false, true], [true, true]];
const ESPERADOS: [number | undefined, number | undefined][] = [[undefined, undefined], [0, undefined], [undefined, 0], [0, 0]];

let barridos = 0, tramosMal = 0, sumaMal = 0, contadoresMal2 = 0, pareados = 0, sueltos = 0, picoMal = 0;

for (const enlace of ENLACES) {
  for (const ei of EMB_IDA) {
    for (const er of EMB_RET) {
      for (const [ci, cr] of CANCELA) {
        for (const [si, sr] of ESPERADOS) {
          barridos++;
          const legs = [
            ...dia("2026-09-14", ei, er, { enlace, canceladaIda: ci, canceladaRet: cr, espIda: si, espRet: sr }),
            ...dia("2026-09-15", ei, er, { enlace, canceladaIda: ci, canceladaRet: cr, espIda: si, espRet: sr }),
          ];
          const fs = analizarOcupacion(legs, FLOTA);

          // (a) NO SE PIERDE NI SE DUPLICA NINGÚN TRAMO.
          if (fs.reduce((a, f) => a + f.tramos, 0) !== legs.length) tramosMal++;

          // (b) Los contadores siguen siendo exhaustivos sobre DÍAS.
          if (fs.some((f) => f.servicios !== f.cancelados + f.medidos + f.sin_manifiesto)) contadoresMal2++;

          // (c) EL PICO JAMÁS ES LA SUMA: ningún día publica más que su tramo más lleno.
          for (const f of fs) {
            for (const d of f.dias) {
              const tope = Math.max(0, ...d.tramos.filter((t) => t.medido).map((t) => t.embarcados));
              if (d.embarcados > tope) sumaMal++;
              if (d.medido && d.embarcados !== tope) picoMal++;
            }
          }

          const dd = fs.flatMap((f) => f.dias);
          if (enlace === "mutuo") { if (dd.every((d) => d.tramos.length === 2)) pareados++; }
          else if (dd.every((d) => d.tramos.length === 1)) sueltos++;
        }
      }
    }
  }
}

chk(`${barridos} combinaciones · no se pierde ni se duplica ningún tramo`, tramosMal === 0, `${tramosMal} fallos`);
chk(`${barridos} combinaciones · servicios = cancelados + medidos + sin manifiesto (sobre DÍAS)`,
  contadoresMal2 === 0, `${contadoresMal2} fallos`);
chk(`${barridos} combinaciones · el pico del día NUNCA supera a su tramo más lleno`,
  sumaMal === 0, `${sumaMal} fallos`);
chk(`${barridos} combinaciones · y es EXACTAMENTE ese máximo`, picoMal === 0, `${picoMal} fallos`);
// El corolario: un motor que no emparejara nunca cumpliría todo lo de arriba.
chk("no es trivial: con enlace mutuo los días SÍ se emparejan, y sin él NO",
  pareados === barridos / 2 && sueltos === barridos / 2,
  `${pareados} pareados · ${sueltos} sueltos de ${barridos / 2} cada uno`);

// ── Cierre ────────────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
