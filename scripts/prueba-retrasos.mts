// Pruebas del SEMÁFORO DE PUNTUALIDAD en ruta. NO tocan la base: datos en memoria contra
// los módulos puros (lib/retrasos.ts + lib/avance-paradas.ts).
// Uso:  npx tsx scripts/prueba-retrasos.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN, y que es exactamente lo que se rompió en producción: que la torre NO
// declare "llegará tarde a X" apuntando a un paradero que el bus ya dejó atrás.
//
// El caso real (SNACKS AMERICA LATINA, reserva #25526, 09-09-2026 23:05): el modal del
// operador decía "2 parada(s) pasada(s) sin marcar · próxima Puente Santa Anita, a 1.4 km,
// llega 23:05" y la fila de la misma pantalla decía "TARDE EN RUTA +47' · llegará tarde a
// Bertello · a 13.9 km · ETA 23:27 vs 22:40 plan". Las dos mitades del mismo tablero
// contándose cosas distintas, y la equivocada era la que además sale por WhatsApp
// (/api/alertas-flota/tick, bloque 4b). Los 13.9 km eran la distancia a un paradero YA
// PASADO: el "retraso" CRECÍA cuanto mejor iba el servicio.
//
// Y la contraparte, que es la mitad que no se puede aflojar: un retraso de VERDAD tiene
// que seguir saliendo. Callarlo sería peor que el falso positivo — un bus 40 min tarde con
// la torre en verde es justo lo que este módulo existe para impedir.
import {
  evaluarPuntualidad, CONFIG_RETRASO_DEFAULT,
  type EntradaPuntualidad, type FixPuntual, type ParadaPuntual,
} from "../lib/retrasos";
import { sembrarAvance, leerAvance, type FixAvance, type ParadaAvance } from "../lib/avance-paradas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── Escenario: recorrido recto de 4 paraderos separados 1 km ────────────────────────
// Una línea de longitud constante y latitud creciente. 1° de latitud ≈ 111 320 m.
const LAT0 = -12.05, LNG0 = -77.05;
const M_POR_GRADO = 111_320;
const enM = (m: number) => ({ lat: LAT0 + m / M_POR_GRADO, lng: LNG0 });

const HOY = "2026-09-09";
const AHORA_MIN = 23 * 60 + 5;                 // 23:05 en Lima, como el caso real
const T0 = Date.parse("2026-09-09T03:30:00Z"); // instante arbitrario; solo importan los deltas

/** Los cuatro paraderos, con el mismo reparto del caso real: el primero SÍ marcado. */
const paradas = (over: Partial<ParadaPuntual>[] = []): ParadaPuntual[] =>
  [
    { id: 901, orden: 1, nombre: "Callao 1RO DE MAYO", ...enM(0),    hora_estimada: "22:35",
      estado: "completada", hora_llegada: "2026-09-10T03:23:00Z" },
    { id: 902, orden: 2, nombre: "Bertello, Callao 07036", ...enM(1000), hora_estimada: "22:40", estado: "pendiente" },
    { id: 903, orden: 3, nombre: "Puente Santa Anita",     ...enM(2000), hora_estimada: "23:00", estado: "pendiente" },
    { id: 904, orden: 4, nombre: "Santa Anita final",      ...enM(3000), hora_estimada: "23:20", estado: "pendiente" },
  ].map((p, i) => ({ ...p, ...(over[i] || {}) })) as ParadaPuntual[];

/** El bus recorre de -200 m a 2200 m: pasa los paraderos 1 y 2, y va llegando al 3. */
const huella: FixAvance[] = [];
for (let m = -200, k = 0; m <= 2200; m += 100, k++) {
  huella.push({ ...enM(m), ts: T0 + k * 5_000, acc: 8 });
}
const ULTIMO = huella[huella.length - 1];
const AHORA_MS = ULTIMO.ts + 30_000;

/** Los fixes recientes que mira lib/retrasos (los últimos, como los trae `fixesDe`). */
const fixes: FixPuntual[] = huella.slice(-15).map((f) => ({ ...f, vel: 12, simulado: false }));

const entrada = (over: Partial<EntradaPuntualidad> = {}): EntradaPuntualidad => ({
  reserva: {
    id: 25526, estado: "en_curso", fecha_servicio: HOY, hora_servicio: "22:30",
    hora_real_inicio: null,
  },
  paradas: paradas(),
  fixes,
  ahoraMs: AHORA_MS,
  ahoraMin: AHORA_MIN,
  hoy: HOY,
  cfg: CONFIG_RETRASO_DEFAULT,
  ...over,
});

// ── 0. El motor de avance ve lo que el modal enseñó: dos paraderos pasados ───────────
// Es la premisa de todo lo demás. Si esto cambia, los casos siguientes dejan de describir
// el caso real y hay que volver a medirlos, no re-ajustar los números hasta que pasen.
const avanceParadas: ParadaAvance[] = paradas().map((p) => ({
  lat: Number(p.lat), lng: Number(p.lng), completada: p.estado === "completada",
}));
const av = leerAvance(sembrarAvance(avanceParadas, huella), avanceParadas);
const PASADAS = paradas().filter((_, i) => av.pasadas[i]).map((p) => p.id);
{
  chk("el motor de avance da por pasados los dos primeros paraderos",
    PASADAS.join(",") === "901,902", `pasadas=[${PASADAS.join(",")}] proximaIdx=${av.proximaIdx}`);
  chk("y el GPS —no el botón— es quien lo dice del segundo",
    av.motivo[1] === "gps", String(av.motivo[1]));
}

// ── 1. EL BUG: sin el avance, la torre apunta al paradero ya pasado ──────────────────
// Se conserva como prueba de que el caso reproducía de verdad. Si algún día esto deja de
// dar `retraso_en_ruta`, el escenario dejó de ser el que se rompió.
{
  const v = evaluarPuntualidad(entrada());
  chk("(regresión) mirando solo el botón, inventa un retraso hacia atrás",
    v.nivel === "retraso_en_ruta" && /Bertello/.test(v.causa),
    `${v.nivel} · ${v.causa} · ${v.evidencia}`);
}

// ── 2. LA CORRECCIÓN: con el avance, el objetivo es el paradero que falta ────────────
{
  const v = evaluarPuntualidad(entrada({ paradasPasadas: PASADAS }));
  chk("con el avance del GPS ya no dice que llegará tarde a Bertello",
    !/Bertello/.test(v.causa) && !/Bertello/.test(v.evidencia), `${v.nivel} · ${v.causa}`);
  chk("el objetivo pasa a ser el siguiente paradero real", v.paradaRefId === 903,
    `paradaRefId=${v.paradaRefId}`);
  chk("y el servicio queda en hora", v.nivel === "en_hora" && !v.escala,
    `${v.nivel} · ${v.causa} · ${v.evidencia}`);
}

// ── 3. EL LADO QUE NO SE PUEDE AFLOJAR: el retraso REAL sigue saliendo ───────────────
// Mismo bus, mismo avance; lo único que cambia es que el paradero que falta estaba
// planificado para las 22:30. Silenciar esto sería mucho peor que el falso positivo.
{
  const tarde = paradas([{}, {}, { hora_estimada: "22:30" }]);
  const v = evaluarPuntualidad(entrada({ paradas: tarde, paradasPasadas: PASADAS }));
  chk("un retraso de verdad se declara igual", v.nivel === "retraso_en_ruta" && v.escala,
    `${v.nivel} · ${v.causa}`);
  chk("contra el paradero correcto y con los minutos reales",
    v.paradaRefId === 903 && /Puente Santa Anita/.test(v.causa) && (v.minutos ?? 0) >= 30,
    `${v.causa} · +${v.minutos} · ${v.evidencia}`);
}

// ── 4. Sin dato de avance, el comportamiento es EXACTAMENTE el de antes ──────────────
// La degradación es la mitad que hace desplegable esto: la huella puede venir vacía, la
// consulta puede fallar y el SQL puede no estar. En ninguno de esos casos puede cambiar
// nada respecto de hoy.
{
  const base = evaluarPuntualidad(entrada());
  for (const [nombre, valor] of [["ausente", undefined], ["vacío", []], ["null", null]] as const) {
    const v = evaluarPuntualidad(entrada({ paradasPasadas: valor as any }));
    chk(`sin avance (${nombre}) el veredicto es idéntico al de siempre`,
      v.nivel === base.nivel && v.paradaRefId === base.paradaRefId && v.causa === base.causa,
      `${v.nivel} vs ${base.nivel}`);
  }
}

// ── 5. El botón del conductor NUNCA se contradice: solo suma ─────────────────────────
// `piso = max(pisoConductor, pisoGps)` visto desde este lado. Una parada marcada sigue
// pasada aunque el GPS no la incluya (el conductor marcó y el bus no tenía señal).
{
  const marcadas = paradas([{}, { estado: "completada" }]);
  const v = evaluarPuntualidad(entrada({ paradas: marcadas, paradasPasadas: [] }));
  chk("una parada marcada sigue contando como pasada sin ayuda del GPS",
    v.paradaRefId === 903, `paradaRefId=${v.paradaRefId}`);
}

// ── 6. Se empareja por ID, jamás por posición ────────────────────────────────────────
// Quien calcula el avance ordena las paradas por su cuenta. Si el emparejamiento fuera
// por índice, una lista que llega en otro orden marcaría el paradero equivocado — el
// fallo que CLAUDE.md documenta tres veces ("escribir con una identidad y leer con otra").
{
  const desordenadas = [...paradas()].reverse();
  const v = evaluarPuntualidad(entrada({ paradas: desordenadas, paradasPasadas: PASADAS }));
  chk("con las paradas en otro orden el objetivo no cambia", v.paradaRefId === 903,
    `paradaRefId=${v.paradaRefId}`);
}

// ── 7. La evidencia dice cuándo el objetivo lo movió el GPS ──────────────────────────
// Sin esta línea, la torre nombra un paradero y el app del conductor otro, y no hay forma
// de saber por qué. Sale SOLO cuando aplicó: un aviso que sale siempre se vuelve paisaje.
{
  const tarde = paradas([{}, {}, { hora_estimada: "22:30" }]);
  const conGps = evaluarPuntualidad(entrada({ paradas: tarde, paradasPasadas: PASADAS }));
  chk("el veredicto declara que el objetivo lo movió el GPS",
    /objetivo por GPS/.test(conGps.evidencia) && /Bertello/.test(conGps.evidencia),
    conGps.evidencia);

  // Mismo servicio con el conductor marcando bien: el GPS no mueve nada y no hay nota.
  const alDia = paradas([{}, { estado: "completada" }, { hora_estimada: "22:30" }]);
  const sinNota = evaluarPuntualidad(entrada({ paradas: alDia, paradasPasadas: PASADAS }));
  chk("con el conductor al día no se agrega ninguna nota",
    sinNota.nivel === "retraso_en_ruta" && !/objetivo por GPS/.test(sinNota.evidencia),
    sinNota.evidencia);
}

// ── 8. Recorrido terminado: sin objetivo NO se inventa un retraso ────────────────────
// El bus pasó todos los paraderos y solo falta cerrar el servicio. Antes el mensaje decía
// "sin paradas pendientes con coordenadas", que manda a arreglar una geocodificación que
// no está rota. El motivo se DECLARA, no se olfatea.
{
  const v = evaluarPuntualidad(entrada({ paradasPasadas: [901, 902, 903, 904] }));
  chk("con todo el recorrido pasado no hay retraso que declarar",
    v.nivel === "en_hora" && !v.escala && v.paradaRefId === null, `${v.nivel} · ${v.causa}`);
  chk("y el motivo nombra lo que de verdad pasa",
    /ya pasó todos los paraderos/.test(v.evidencia), v.evidencia);
}

// ── 9. Un recorrido sin geocodificar sigue diciendo lo suyo ──────────────────────────
// El otro mundo del mismo `if`: aquí sí falta un dato y se arregla en la ficha de la ruta.
{
  const sinCoords = paradas().map((p) => ({ ...p, lat: null, lng: null, estado: "pendiente" }));
  const v = evaluarPuntualidad(entrada({ paradas: sinCoords, paradasPasadas: [] }));
  chk("sin coordenadas el mensaje sigue apuntando a la ficha de la ruta",
    /sin paradas pendientes con coordenadas/.test(v.evidencia), v.evidencia);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
