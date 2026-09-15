// Pruebas de LA HORA DEL SERVICIO CONTRA SUS PARADEROS. NO tocan la base: datos en
// memoria contra el módulo puro (lib/paradas-hora.ts).
// Uso:  npx tsx scripts/prueba-paradas-hora.mts   (sale con código 1 si algo falla)
//
// EL CASO REAL (lunes 14-09-2026, reportado por el dueño). El operador corrió el
// horario de un contrato fijo desde /programacion y lo propagó al resto del contrato.
// `reservas.hora_servicio` cambió en los servicios futuros y al abrir el lunes 21 los
// PARADEROS seguían con la hora vieja. De los paraderos —no de `hora_servicio`— salen
// el aviso al pasajero, la app del conductor, la hoja de ruta y el semáforo de
// puntualidad: la hora que NO se movió es justamente la que llega a la calle.
//
// LO QUE FIJA ESTA MATRIZ, y la mitad que más importa es la segunda:
//
//   · Que el defecto se reproduce con el algoritmo VIEJO, copiado literal más abajo.
//     Si deja de reproducirlo, el escenario dejó de ser el que se rompió.
//   · EL LADO QUE NO SE PUEDE AFLOJAR: un desplazamiento legítimo tiene que seguir
//     escribiéndose. Un motor que no tocara nunca nada cumpliría de forma trivial todo
//     lo demás — y apagaría la funcionalidad sin que nadie lo note.
import {
  planDeHoraParaderos, deltaHoras, correrHora, minutosHHMM, etiquetaDelta,
  type ParadaFila, type ParadaSemilla,
} from "../lib/paradas-hora";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const sec = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 74 - t.length))}`);

// ── El algoritmo VIEJO, copiado literal de app/programacion/page.tsx ──────────────────
// (1) el editor inline de la fila corría SOLO las filas de `paradas`; (2) el formulario
// y el masivo del contrato no corrían nada. Se conservan los dos para que la matriz
// demuestre el defecto en vez de describirlo.
const VIEJO_inline = (filas: ParadaFila[], horaAntes: string, horaNueva: string) => {
  const deltaMin = horaAntes ? minutosHHMM(horaNueva) - minutosHHMM(horaAntes) : 0;
  const paradas = deltaMin === 0 ? [] : filas
    .filter((p: any) => p.hora_estimada)
    .map((p: any) => ({ id: p.id, nombre: p.nombre, de: String(p.hora_estimada).slice(0, 5), a: correrHora(p.hora_estimada, deltaMin) }));
  return { filas: paradas, semilla: null as ParadaSemilla[] | null };
};
const VIEJO_masivo = () => ({ filas: [] as any[], semilla: null as ParadaSemilla[] | null });

// El contrato real: ENTRADA 05:10, tres paraderos, corrido a las 05:25 (+15 min).
const SEMILLA: ParadaSemilla[] = [
  { tipo: "inicio",      nombre: "BSF",             hora: "05:10" },
  { tipo: "intermedia",  nombre: "1RO DE MAYO",     hora: "05:25" },
  { tipo: "destino",     nombre: "SNACKS AMERICA",  hora: "06:05" },
];
const FILAS = (over: Partial<ParadaFila>[] = []): ParadaFila[] =>
  SEMILLA.map((p, i) => ({
    id: 900 + i, nombre: String(p.nombre), hora_estimada: `${p.hora}:00`, estado: "pendiente",
    ...(over[i] || {}),
  }));

// ══════════════════════════════════════════════════════════════════════════════
sec("1 · EL DEFECTO REPORTADO, reproducido con el algoritmo viejo");

{
  // El servicio del lunes 21: programa fijo recién generado. `ModalGenerarPrograma`
  // escribe SOLO `paradas_json`; las filas de `paradas` no existen hasta que alguien
  // abre el servicio. Es el estado en el que estaban los cien servicios futuros.
  const viejoMasivo = VIEJO_masivo();
  chk("VIEJO · el masivo del contrato no tocaba ningún paradero",
    viejoMasivo.filas.length === 0 && viejoMasivo.semilla === null);

  const viejoInline = VIEJO_inline([], "05:10", "05:25");
  chk("VIEJO · el editor inline tampoco movía nada sin filas materializadas",
    viejoInline.filas.length === 0 && viejoInline.semilla === null);

  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:25", filas: [], semilla: SEMILLA });
  chk("AHORA · la semilla se corre aunque no haya filas materializadas",
    p.codigo === "corre" && p.semilla !== null, p.codigo);
  chk("…y las tres horas quedan corridas +15 conservando el espaciado",
    JSON.stringify(p.semilla?.map(x => x.hora)) === JSON.stringify(["05:25", "05:40", "06:20"]),
    JSON.stringify(p.semilla?.map(x => x.hora)));
}

{
  // Y con las filas ya materializadas, la semilla SE CORRE IGUAL: es de donde
  // `crearParadasDesdeJSON` y `cargarParadasReserva` las rehacen. Dejarla vieja
  // re-inyecta la hora anterior servicio por servicio durante lo que dure el contrato.
  const viejo = VIEJO_inline(FILAS(), "05:10", "05:25");
  chk("VIEJO · con filas sí las corría…",
    viejo.filas.length === 3 && viejo.filas[0].a === "05:25");
  chk("VIEJO · …pero dejaba la SEMILLA con la hora vieja (el arreglo se deshacía solo)",
    viejo.semilla === null);

  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:25", filas: FILAS(), semilla: SEMILLA });
  chk("AHORA · se corren las DOS caras del itinerario",
    p.filas.length === 3 && p.semilla !== null, `${p.filas.length} filas`);
  chk("…y las dos dicen lo mismo",
    JSON.stringify(p.filas.map(f => f.a)) === JSON.stringify(p.semilla?.map(x => x.hora)));
}

// ══════════════════════════════════════════════════════════════════════════════
sec("2 · SE CORRE POR DELTA, NO SE FIJA EL PRIMERO");

{
  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:25", filas: FILAS() });
  chk("el primero recibe la hora nueva del servicio", p.filas[0].a === "05:25", p.filas[0].a);
  chk("y los demás se mueven el mismo desplazamiento, no se quedan",
    p.filas[1].a === "05:40" && p.filas[2].a === "06:20",
    p.filas.map(f => `${f.de}→${f.a}`).join(" "));
  const huecos = p.filas.map(f => minutosHHMM(f.a)).map((v, i, a) => i ? v - a[i - 1] : 0).slice(1);
  chk("el espaciado del recorrido queda intacto (15 y 40 min)",
    JSON.stringify(huecos) === JSON.stringify([15, 40]), JSON.stringify(huecos));
}

{
  // Adelantar es el mismo gesto con el signo contrario.
  const p = planDeHoraParaderos({ horaAntes: "06:00", horaNueva: "05:30", filas: FILAS() });
  chk("un adelanto de 30 min corre todo hacia atrás",
    p.deltaMin === -30 && p.filas[0].a === "04:40" && p.filas[2].a === "05:35",
    p.filas.map(f => f.a).join(" "));
}

{
  // Cruzar medianoche: un nocturno que se adelanta desde las 00:20.
  const filas: ParadaFila[] = [{ id: 1, nombre: "COCHERA", hora_estimada: "00:20", estado: "pendiente" }];
  const p = planDeHoraParaderos({ horaAntes: "00:20", horaNueva: "23:50", filas });
  chk("cruzar medianoche envuelve dentro del día, nunca sale un '-01:30'",
    /^\d{2}:\d{2}$/.test(p.filas[0].a) && p.filas[0].a === "23:50", p.filas[0].a);
}

// ══════════════════════════════════════════════════════════════════════════════
sec("3 · LO QUE NO SE TOCA, con su motivo DECLARADO");

{
  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:10", filas: FILAS(), semilla: SEMILLA });
  chk("la hora no se movió: nada que correr", p.codigo === "sin_delta"
    && p.filas.length === 0 && p.semilla === null, p.codigo);
}

{
  // Sin hora anterior no se sabe DESDE DÓNDE medir. Suponer cero movería los paraderos
  // por una cantidad que nadie declaró: el lado seguro es no tocarlos y decirlo.
  const p = planDeHoraParaderos({ horaAntes: "", horaNueva: "05:25", filas: FILAS(), semilla: SEMILLA });
  chk("sin hora anterior no se inventa el desplazamiento",
    p.codigo === "sin_hora_anterior" && p.filas.length === 0 && p.semilla === null, p.codigo);
  chk("…y el motivo manda a revisarlas a mano, no dice 'no hay paraderos'",
    /hora anterior/i.test(p.motivo) && /una por una/i.test(p.motivo), p.motivo);
  chk("deltaHoras lo declara `null`, que NO es cero",
    deltaHoras("", "05:25") === null && deltaHoras("05:10", "05:25") === 15);
}

{
  // Un servicio sin paraderos propios: su itinerario cuelga de la cotización. Que no
  // se pueda mover desde acá es un DATO para el operador, no un silencio.
  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:25", filas: [], semilla: null });
  chk("sin paraderos propios: código propio", p.codigo === "sin_paraderos", p.codigo);
  chk("…y el motivo nombra de dónde sale su hora y qué hacer",
    /cotizaci/i.test(p.motivo), p.motivo);
}

{
  // Tiene paraderos pero ninguno declara hora. No hay nada que correr — y escribirles
  // una sería fabricar un compromiso que nadie pactó.
  const filas: ParadaFila[] = [
    { id: 1, nombre: "BSF", hora_estimada: null, estado: "pendiente" },
    { id: 2, nombre: "SNACKS", hora_estimada: "", estado: "pendiente" },
  ];
  const semilla: ParadaSemilla[] = [{ nombre: "BSF" }, { nombre: "SNACKS", hora: "" }];
  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:25", filas, semilla });
  chk("paraderos sin hora: no se les inventa ninguna",
    p.codigo === "sin_horas" && p.filas.length === 0 && p.semilla === null, p.codigo);
}

{
  // Mezcla: unos con hora y otros sin. Se mueven los que la tienen, a los otros no se
  // les escribe una — son dos cosas distintas y solo una es un desplazamiento.
  const filas = FILAS([{}, { hora_estimada: null }, {}]);
  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:25", filas });
  chk("el paradero sin hora se queda sin hora, no hereda una",
    p.codigo === "corre" && p.filas.length === 2 && !p.filas.some(f => f.id === 901),
    p.filas.map(f => f.id).join(","));
}

{
  // Un paradero YA RECORRIDO conserva su hora planificada: es el patrón contra el que
  // se midió si el bus llegó tarde (lib/retrasos.ts). Correrla reescribiría el
  // veredicto de un tramo que ya ocurrió.
  const filas = FILAS([{ estado: "completada" }, {}, {}]);
  const p = planDeHoraParaderos({ horaAntes: "05:10", horaNueva: "05:25", filas });
  chk("el paradero ya recorrido no se mueve",
    p.filas.length === 2 && !p.filas.some(f => f.id === 900), p.filas.map(f => f.id).join(","));
  chk("…y se CUENTA, para poder decirlo en pantalla", p.congeladas === 1, String(p.congeladas));
}

// ══════════════════════════════════════════════════════════════════════════════
sec("4 · EL LADO QUE NO SE PUEDE AFLOJAR");

{
  // Un motor que nunca escribiera nada cumpliría de forma trivial toda la sección 3.
  // Estos son los casos en que TIENE que escribir, o el defecto vuelve por otra puerta.
  const casos: [string, Parameters<typeof planDeHoraParaderos>[0]][] = [
    ["solo filas",            { horaAntes: "05:10", horaNueva: "05:25", filas: FILAS() }],
    ["solo semilla",          { horaAntes: "05:10", horaNueva: "05:25", semilla: SEMILLA }],
    ["filas + semilla",       { horaAntes: "05:10", horaNueva: "05:25", filas: FILAS(), semilla: SEMILLA }],
    ["un solo minuto",        { horaAntes: "05:10", horaNueva: "05:11", filas: FILAS() }],
    ["hora con segundos",     { horaAntes: "05:10:00", horaNueva: "05:25", filas: FILAS() }],
    ["hora sin cero delante", { horaAntes: "5:10", horaNueva: "5:25", filas: FILAS() }],
  ];
  for (const [nombre, e] of casos) {
    const p = planDeHoraParaderos(e);
    chk(`${nombre}: se corre de verdad`,
      p.codigo === "corre" && (p.filas.length > 0 || p.semilla !== null), p.codigo);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
sec("5 · INVARIANTES por barrido");

{
  // Rejilla: 24 horas de origen × 24 de destino × 4 formas del servicio. Lo que se fija
  // vale para toda la rejilla, no para los casos que a alguien se le ocurrieron.
  const formas: [string, ParadaFila[], ParadaSemilla[] | null][] = [
    ["filas+semilla", FILAS(), SEMILLA],
    ["solo filas",    FILAS(), null],
    ["solo semilla",  [],      SEMILLA],
    ["nada",          [],      null],
  ];
  let n = 0, malCodigo = 0, malDelta = 0, malSemilla = 0, malMotivo = 0;
  for (let h0 = 0; h0 < 24; h0++) for (let h1 = 0; h1 < 24; h1++) for (const [, filas, semilla] of formas) {
    const a = `${String(h0).padStart(2, "0")}:10`;
    const b = `${String(h1).padStart(2, "0")}:10`;
    const p = planDeHoraParaderos({ horaAntes: a, horaNueva: b, filas, semilla });
    n++;
    // (i) `corre` ⟺ se escribe algo. Ningún otro código puede dejar escritura pendiente.
    const escribe = p.filas.length > 0 || p.semilla !== null;
    if ((p.codigo === "corre") !== escribe) malCodigo++;
    // (ii) toda fila corrida cumple a = de + delta (mod 1440). El delta es UNO solo.
    if (p.filas.some(f => minutosHHMM(f.a) !== ((minutosHHMM(f.de) + p.deltaMin) % 1440 + 1440) % 1440)) malDelta++;
    // (iii) la semilla se mueve por el MISMO delta que las filas.
    if (p.semilla?.some((x, i) =>
      minutosHHMM(String(x.hora)) !== ((minutosHHMM(String(SEMILLA[i].hora)) + p.deltaMin) % 1440 + 1440) % 1440)) malSemilla++;
    // (iv) todo plan lleva un motivo legible: el código es para enrutar, no para leer.
    if (!p.motivo || p.motivo.length < 12) malMotivo++;
  }
  chk(`barrido de ${n} combinaciones · 'corre' ⟺ hay algo que escribir`, malCodigo === 0, String(malCodigo));
  chk("toda fila corrida cumple  a = de + delta (mod 24 h)", malDelta === 0, String(malDelta));
  chk("la semilla se corre por el MISMO delta que las filas", malSemilla === 0, String(malSemilla));
  chk("todo plan declara un motivo legible", malMotivo === 0, String(malMotivo));
}

{
  // El delta que se le enseña al operador es el mismo que se escribe.
  chk("etiquetaDelta describe el sentido real",
    etiquetaDelta(15).includes("después") && etiquetaDelta(-15).includes("antes")
    && etiquetaDelta(0) === "sin cambio");
}

console.log(`\n${fallos === 0 ? "✅ TODO EN VERDE" : `❌ ${fallos} FALLA(S)`}`);
process.exit(fallos === 0 ? 0 : 1);
