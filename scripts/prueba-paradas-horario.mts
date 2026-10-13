// Pruebas de LA HORA DE CADA PARADERO CALCULADA DESDE LA RUTA (lib/paradas-horario.ts).
// NO tocan la base ni Google: datos en memoria contra el módulo puro.
// Uso:  npx tsx scripts/prueba-paradas-horario.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJA, y la mitad que más importa es la última:
//   · Las reglas de la cadena: la espera solo en intermedios, el cruce de medianoche, el
//     re-anclaje en una hora escrita (y su aviso si es imposible), y que nada se calcule a
//     medias sin coordenadas.
//   · La fecha cuyo tráfico se consulta, en hora Lima (a las 23:30 de Lima, UTC ya es mañana).
//   · Por barrido: en «vacias» JAMÁS se pisa una hora escrita; en «todas» las llegadas no
//     decrecen; la salida que se le manda a Google nunca es pasada.
//   · EL COROLARIO: el motor SÍ llena algo cuando hay datos. Un motor que no escribiera nunca
//     ninguna hora cumpliría de forma trivial todo lo anterior.
import {
  planHoras, horaFijaDe, pasoCadena, estadoMarca, indiceDeInsercion, validarSalida, fechaReferencia,
  firmaParaderos, modoRecomendado, requisitosHoras, segundosDeTramoRuta, costoEstimado,
  ESPERA_DEFECTO_MIN, MAX_PARADEROS_TRAFICO, PRECIO_USD,
  type ParadaHorario, type HoraCalc,
} from "../lib/paradas-horario";
import { firmaRuta } from "../lib/ruta-firma";
import { firmaRuta as firmaRutaReexport } from "../lib/rutas-cache";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const sec = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 74 - t.length))}`);

const P = (id: string, tipo: ParadaHorario["tipo"], hora = "", lat = "-12.05", lng = "-77.05", nombre = id): ParadaHorario =>
  ({ id, tipo, nombre, lat, lng, hora });
const CALC: Omit<HoraCalc, "hora" | "dia"> = { modo: "trafico", firma: "F", espera_min: 1, fecha_ref: "2026-10-19" };

/** "YYYY-MM-DD HH:MM" Lima → ms UTC. */
const lima = (f: string, h: string) => {
  const [y, m, d] = f.split("-").map(Number);
  const [hh, mm] = h.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh + 5, mm);
};

// ── 1. Constantes declaradas ──────────────────────────────────────────────────────────
sec("1. Constantes");
chk("espera por defecto 1 min", ESPERA_DEFECTO_MIN === 1);
chk("tope de paraderos con tráfico 20", MAX_PARADEROS_TRAFICO === 20);
chk("precios de lista de la cabecera de /api/ruta", PRECIO_USD.essentials === 0.005 && PRECIO_USD.advanced === 0.01);
chk("modo recomendado: fijo → tráfico", modoRecomendado("fijo").modo === "trafico");
chk("modo recomendado: eventual → sin tráfico", modoRecomendado("eventual").modo === "sin_trafico");
chk("costo: 5 paraderos con tráfico + pesimista = 5 consultas", costoEstimado(5, "trafico", true).consultas === 5 && costoEstimado(5, "trafico", true).usd === 0.05);
chk("costo: sin tráfico = 1 consulta Essentials", costoEstimado(9, "sin_trafico").consultas === 1);
// tsx puede cargar el módulo dos veces (ESM/CJS), así que se compara el resultado, no la identidad.
chk("firmaRuta re-exportada desde rutas-cache firma igual", firmaRutaReexport([{ lat: -12.1234567, lng: -77.1 }]) === firmaRuta([{ lat: -12.1234567, lng: -77.1 }]));

// ── 2. Suma con espera ────────────────────────────────────────────────────────────────
sec("2. Cadena: suma con espera solo en intermedios");
{
  const paradas = [P("a", "inicio", "06:00"), P("b", "intermedia"), P("c", "intermedia"), P("d", "destino")];
  const r = planHoras({ paradas, tramosS: [600, 900, 1200], esperaMin: 2, modo: "vacias", calc: CALC });
  chk("ok", r.codigo === "ok");
  chk("a 06:00 salida", r.filas[0].hora === "06:00" && r.filas[0].codigo === "salida");
  chk("b 06:10 (llegada, sin espera previa del inicio)", r.filas[1].hora === "06:10", r.filas[1].hora);
  chk("c 06:27 (06:10 + 2 espera + 15)", r.filas[2].hora === "06:27", r.filas[2].hora);
  chk("d 06:49 (06:27 + 2 + 20)", r.filas[3].hora === "06:49", r.filas[3].hora);
  chk("llegada = destino", r.llegada === "06:49");
  chk("las calculadas llevan su marca", r.filas[1].hora_calc?.hora === "06:10" && r.filas[1].hora_calc?.firma === "F");
  chk("la salida no lleva marca (es manual)", !r.filas[0].hora_calc);
  // Segundos: se redondea AL FINAL, no por tramo.
  const r2 = planHoras({ paradas: [P("a", "inicio", "06:00"), P("b", "intermedia"), P("c", "intermedia"), P("d", "destino")],
    tramosS: [89, 89, 89], esperaMin: 0, modo: "vacias", calc: CALC });
  chk("segundos acumulados: 3×89 s = 4.45 min → 06:04 (redondear por tramo daría 06:03 o 06:06)", r2.filas[3].hora === "06:04", r2.filas[3].hora);
}

// ── 3. Medianoche ─────────────────────────────────────────────────────────────────────
sec("3. Cruce de medianoche");
{
  const r = planHoras({ paradas: [P("a", "inicio", "23:50"), P("b", "intermedia"), P("c", "destino")],
    tramosS: [600, 900], esperaMin: 1, modo: "vacias", calc: CALC });
  chk("b 00:00 del día siguiente", r.filas[1].hora === "00:00" && r.filas[1].dia === 1, JSON.stringify(r.filas[1]));
  chk("c 00:16 día 1", r.filas[2].hora === "00:16" && r.filas[2].dia === 1);
  chk("la marca lleva dia 1", r.filas[2].hora_calc?.dia === 1);
}

// ── 4. vacías vs todas ────────────────────────────────────────────────────────────────
sec("4. «vacias» respeta lo escrito; «todas» pisa y cuenta");
{
  const paradas = [P("a", "inicio", "06:00"), P("b", "intermedia", "06:20"), P("c", "intermedia"), P("d", "destino", "06:30")];
  const v = planHoras({ paradas, tramosS: [600, 600, 600], esperaMin: 0, modo: "vacias", calc: CALC });
  chk("vacias: b conservada 06:20 (escrita después de la llegada posible 06:10)", v.filas[1].hora === "06:20" && v.filas[1].codigo === "conservada_manual");
  chk("vacias: c se encadena desde la escrita → 06:30", v.filas[2].hora === "06:30" && v.filas[2].codigo === "calculada", v.filas[2].hora);
  chk("vacias: d escrita 06:30 = llegada posible 06:40? no: es ANTES → reanclada + aviso", v.filas[3].codigo === "reanclada" && !!v.filas[3].aviso && v.filas[3].hora === "06:30");
  chk("vacias: pisaria 0", v.pisaria === 0);
  const t = planHoras({ paradas, tramosS: [600, 600, 600], esperaMin: 0, modo: "todas", calc: CALC });
  chk("todas: b 06:10 pisada", t.filas[1].hora === "06:10" && t.filas[1].codigo === "pisada");
  chk("todas: d 06:30 = escrita → calculada (no cuenta)", t.filas[3].hora === "06:30" && t.filas[3].codigo === "calculada");
  chk("todas: pisaria 1", t.pisaria === 1, String(t.pisaria));
  chk("todas: la salida nunca se pisa", t.filas[0].hora === "06:00" && t.filas[0].codigo === "salida");
}

// ── 5. pasoCadena directo ─────────────────────────────────────────────────────────────
sec("5. pasoCadena: re-anclaje y aviso");
{
  const p1 = pasoCadena({ min: 360, dia: 0 }, 600, 2, true, null);
  chk("llegada 06:10, salida 06:12", p1.llegada.min === 370 && p1.salida.min === 372 && !p1.reanclada);
  const p2 = pasoCadena({ min: 360, dia: 0 }, 600, 2, false, null);
  chk("el destino no espera", p2.salida.min === 370);
  const p3 = pasoCadena({ min: 360, dia: 0 }, 600, 2, true, "06:05");
  chk("escrita antes de la llegada → aviso, re-ancla en 06:05", p3.reanclada && p3.aviso === "manual_antes_de_llegar" && p3.llegada.min === 365 && p3.salida.min === 367);
  const p4 = pasoCadena({ min: 1430, dia: 0 }, 600, 0, true, "00:05");
  chk("escrita 00:05 tras salir 23:50 con 10 min de tramo = día siguiente, sin aviso", p4.llegada.dia === 1 && p4.llegada.min === 5 && !p4.aviso, JSON.stringify(p4));
  const p5 = pasoCadena({ min: 360, dia: 0 }, 600, 0, false, "06:10");
  chk("escrita igual a la llegada → sin aviso", p5.reanclada && !p5.aviso);
}

// ── 6. Requisitos ─────────────────────────────────────────────────────────────────────
sec("6. Requisitos: no se calcula a medias");
{
  const r = planHoras({ paradas: [P("a", "inicio", "06:00"), P("b", "intermedia", "", "", "", "Puente Santa Anita"), P("c", "destino", "", "x", "-77", "Planta")],
    tramosS: [1, 1], esperaMin: 0, modo: "vacias", calc: CALC });
  chk("sin_coordenadas con los nombres", r.codigo === "sin_coordenadas" && r.faltanCoords.join(",") === "Puente Santa Anita,Planta" && r.filas.length === 0, r.faltanCoords.join(","));
  chk("pocos_puntos", planHoras({ paradas: [P("a", "inicio", "06:00")], tramosS: [], esperaMin: 0, modo: "vacias", calc: CALC }).codigo === "pocos_puntos");
  chk("sin_hora_salida", planHoras({ paradas: [P("a", "inicio"), P("b", "destino")], tramosS: [60], esperaMin: 0, modo: "vacias", calc: CALC }).codigo === "sin_hora_salida");
  chk("tramos_no_cuadran", planHoras({ paradas: [P("a", "inicio", "06:00"), P("b", "destino")], tramosS: [], esperaMin: 0, modo: "vacias", calc: CALC }).codigo === "tramos_no_cuadran");
  chk("tramo negativo no cuadra", planHoras({ paradas: [P("a", "inicio", "06:00"), P("b", "destino")], tramosS: [-5], esperaMin: 0, modo: "vacias", calc: CALC }).codigo === "tramos_no_cuadran");
  chk("requisitos antes de gastar: ok sin tramos", requisitosHoras([P("a", "inicio", "06:00"), P("b", "destino")]).codigo === "ok");
  chk("segundosDeTramoRuta: duracion_s manda", segundosDeTramoRuta({ duracion_s: 125, duracion_min: 2 }) === 125);
  chk("segundosDeTramoRuta: caché vieja sin duracion_s → min×60", segundosDeTramoRuta({ duracion_min: 2 }) === 120);
  chk("segundosDeTramoRuta: nada → null", segundosDeTramoRuta({}) === null);
}

// ── 7. fechaReferencia ────────────────────────────────────────────────────────────────
sec("7. fechaReferencia (Lima UTC-5)");
{
  // Martes 13-10-2026 23:30 Lima = miércoles 14 04:30 UTC.
  const ahora = lima("2026-10-13", "23:30");
  chk("UTC ya es el día siguiente (premisa)", new Date(ahora).toISOString().slice(0, 10) === "2026-10-14");
  const f1 = fechaReferencia({ modoServicio: "fijo", horaSalida: "06:00", sentido: "ida", ahoraMs: ahora });
  chk("fijo a las 23:30 Lima del martes → miércoles 14 (mañana Lima, no jueves)", f1.ok && f1.fecha === "2026-10-14", JSON.stringify(f1));
  // Sábado 17-10-2026 10:00 Lima.
  const sab = lima("2026-10-17", "10:00");
  const f2 = fechaReferencia({ modoServicio: "fijo", horaSalida: "06:00", sentido: "ida", ahoraMs: sab });
  chk("fijo un sábado → lunes 19", f2.ok && f2.fecha === "2026-10-19" && f2.supuesta, JSON.stringify(f2));
  const f2b = fechaReferencia({ modoServicio: "fijo", fechaServicio: "2026-10-24", horaSalida: "06:00", sentido: "ida", ahoraMs: sab });
  chk("fijo con inicio un sábado futuro → lunes 26", f2b.ok && f2b.fecha === "2026-10-26");
  const f3 = fechaReferencia({ modoServicio: "eventual", fechaServicio: "2026-10-10", horaSalida: "08:00", sentido: "ida", ahoraMs: sab });
  // 10-10-2026 es sábado → próximo sábado posterior a hoy (sáb 17): sáb 24.
  chk("eventual con fecha pasada (sáb 10) → sáb 24, supuesta", f3.ok && f3.fecha === "2026-10-24" && f3.supuesta, JSON.stringify(f3));
  const f4 = fechaReferencia({ modoServicio: "eventual", fechaServicio: "2026-10-22", horaSalida: "08:00", sentido: "ida", ahoraMs: sab });
  chk("eventual con fecha futura → su fecha, no supuesta", f4.ok && f4.fecha === "2026-10-22" && !f4.supuesta);
  const f5 = fechaReferencia({ modoServicio: "eventual", horaSalida: "08:00", sentido: "ida", ahoraMs: sab });
  chk("eventual sin fecha → próximo hábil (lun 19)", f5.ok && f5.fecha === "2026-10-19" && f5.supuesta);
  const f6 = fechaReferencia({ modoServicio: "eventual", fechaServicio: "2026-10-22", horaSalida: "01:00", horaSalidaIda: "18:00", sentido: "retorno", ahoraMs: sab });
  chk("retorno nocturno (sale 01:00, ida 18:00) → día siguiente de la ida", f6.ok && f6.fecha === "2026-10-23" && !f6.supuesta, JSON.stringify(f6));
  const f7 = fechaReferencia({ modoServicio: "eventual", fechaServicio: "2026-10-22", horaSalida: "17:00", horaSalidaIda: "06:00", sentido: "retorno", ahoraMs: sab });
  chk("retorno el mismo día de la ida", f7.ok && f7.fecha === "2026-10-22");
  chk("sin hora de salida", fechaReferencia({ modoServicio: "fijo", horaSalida: "", sentido: "ida", ahoraMs: sab }).ok === false);
  // Martes 23:58: mañana 00:01 ya no admite el margen de 5 min.
  const f8 = fechaReferencia({ modoServicio: "fijo", horaSalida: "00:01", sentido: "ida", ahoraMs: lima("2026-10-13", "23:58") });
  chk("fijo 23:58 con salida 00:01 → pasa al siguiente hábil", f8.ok && f8.fecha === "2026-10-15", JSON.stringify(f8));
}

// ── 8. validarSalida ──────────────────────────────────────────────────────────────────
sec("8. validarSalida");
{
  const ahora = lima("2026-10-13", "10:00");
  const v1 = validarSalida("2026-10-13", "10:06", ahora);
  chk("6 min adelante ok, epoch exacto", v1.ok && v1.epochS === lima("2026-10-13", "10:06") / 1000);
  chk("4 min adelante → salida_pasada", (validarSalida("2026-10-13", "10:04", ahora) as any).codigo === "salida_pasada");
  chk("ayer → salida_pasada", (validarSalida("2026-10-12", "10:00", ahora) as any).codigo === "salida_pasada");
  chk("a 91 días → salida_lejana", (validarSalida("2027-01-12", "10:01", ahora) as any).codigo === "salida_lejana");
  chk("fecha inválida", (validarSalida("2026-02-30", "10:00", ahora) as any).codigo === "invalida");
  chk("hora inválida", (validarSalida("2026-10-20", "25:00", ahora) as any).codigo === "invalida");
}

// ── 9. estadoMarca + firma ────────────────────────────────────────────────────────────
sec("9. estadoMarca y firmaParaderos");
{
  const ps = [P("a", "inicio", "06:00", "-12.000001", "-77.000001"), P("b", "destino", "06:10", "-12.1", "-77.1")];
  const f = firmaParaderos(ps);
  chk("firma estable con 5 decimales", f === "-12.00000,-77.00000|-12.10000,-77.10000", f);
  chk("firma con paradero sin coords lleva ?", firmaParaderos([{ lat: "", lng: "" }, { lat: 1, lng: 2 }]) === "?|1.00000,2.00000");
  const conMarca = (hora: string, marcaHora: string, firma: string): ParadaHorario =>
    ({ ...ps[1], hora, hora_calc: { hora: marcaHora, modo: "trafico", firma, espera_min: 1 } });
  chk("sin marca → manual", estadoMarca(ps[1], f) === "manual");
  chk("misma hora y firma → vigente", estadoMarca(conMarca("06:10", "06:10", f), f) === "vigente");
  chk("hora editada → manual", estadoMarca(conMarca("06:15", "06:10", f), f) === "manual");
  chk("paraderos movidos → desactualizada", estadoMarca(conMarca("06:10", "06:10", "otra"), f) === "desactualizada");
  chk("HH:MM:SS vs HH:MM cuenta como la misma hora", estadoMarca(conMarca("06:10:00", "06:10", f), f) === "vigente");
}

// ── 10. indiceDeInsercion ─────────────────────────────────────────────────────────────
sec("10. indiceDeInsercion");
{
  // Ruta en L: este → norte. Paraderos en (0,0), (0.02,0), (0.02,0.02), (0,0.02) [lng,lat].
  const poli: [number, number][] = [[0, 0], [0.01, 0], [0.02, 0], [0.02, 0.01], [0.02, 0.02], [0.01, 0.02], [0, 0.02]];
  const paradas = [{ lng: 0, lat: 0 }, { lng: 0.02, lat: 0 }, { lng: 0.02, lat: 0.02 }, { lng: 0, lat: 0.02 }];
  chk("punto en el primer tramo → 1", indiceDeInsercion(poli, paradas, [0.01, 0.0005]) === 1);
  chk("punto en el segundo tramo → 2", indiceDeInsercion(poli, paradas, [0.0205, 0.01]) === 2);
  chk("punto en el tercer tramo → 3", indiceDeInsercion(poli, paradas, [0.01, 0.0195]) === 3);
  chk("antes del inicio → nunca 0", indiceDeInsercion(poli, paradas, [-0.01, 0]) === 1);
  chk("después del destino → nunca n", indiceDeInsercion(poli, paradas, [-0.01, 0.02]) === 3);
  // Ruta que vuelve por una paralela: el punto está físicamente cerca del paradero 0 pero a lo
  // largo del recorrido está en el último tramo.
  const ida: [number, number][] = [[0, 0], [0.02, 0], [0.02, 0.001], [0, 0.001]];
  const pIda = [{ lng: 0, lat: 0 }, { lng: 0.02, lat: 0 }, { lng: 0, lat: 0.001 }];
  chk("ruta que vuelve por la paralela → tramo de vuelta (2)", indiceDeInsercion(ida, pIda, [0.005, 0.0011]) === 2);
  chk("sin polilínea: segmento recto más cercano", indiceDeInsercion([], paradas, [0.0205, 0.01]) === 2);
}

// ── 11. Barrido de invariantes ────────────────────────────────────────────────────────
sec("11. Barrido: invariantes y corolario");
{
  let rng = 12345;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const hh = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  let casos = 0, pisadas = 0, noDecrece = 0, llenadas = 0;
  for (let k = 0; k < 4000; k++) {
    const n = 2 + Math.floor(rand() * 9);
    const ps: ParadaHorario[] = [];
    for (let i = 0; i < n; i++) {
      const tipo = i === 0 ? "inicio" : i === n - 1 ? "destino" : "intermedia";
      const hora = i === 0 ? hh(Math.floor(rand() * 1440)) : rand() < 0.35 ? hh(Math.floor(rand() * 1440)) : "";
      ps.push(P(`p${i}`, tipo, hora));
    }
    const tramos = Array.from({ length: n - 1 }, () => Math.floor(rand() * 3600));
    const espera = Math.floor(rand() * 4);
    for (const modo of ["vacias", "todas"] as const) {
      const r = planHoras({ paradas: ps, tramosS: tramos, esperaMin: espera, modo, calc: CALC });
      casos++;
      if (r.codigo !== "ok" || r.filas.length !== n) { pisadas++; continue; }
      if (modo === "vacias") {
        for (let i = 0; i < n; i++) {
          if (ps[i].hora && r.filas[i].hora !== ps[i].hora) pisadas++;
          if (!ps[i].hora && r.filas[i].codigo === "calculada") llenadas++;
        }
      } else {
        let ant = -1;
        for (let i = 0; i < n; i++) {
          const [h, m] = r.filas[i].hora.split(":").map(Number);
          const t = r.filas[i].dia * 1440 + h * 60 + m;
          if (t < ant) noDecrece++;
          ant = t;
        }
        if (r.pisaria !== r.filas.filter((f) => f.codigo === "pisada").length) noDecrece++;
      }
    }
  }
  chk(`«vacias» nunca pisa una hora escrita (${casos} planes)`, pisadas === 0, String(pisadas));
  chk("«todas»: las llegadas no decrecen (contando dia) y pisaria = filas pisadas", noDecrece === 0, String(noDecrece));
  chk("COROLARIO: el motor sí llena horas vacías", llenadas > 1000, String(llenadas));

  // La salida enviada a Google nunca es pasada: toda fecha que devuelve fechaReferencia
  // valida con su hora, en cualquier instante del año.
  let pasadas = 0, validas = 0;
  const base = lima("2026-01-01", "00:00");
  for (let k = 0; k < 3000; k++) {
    const ahora = base + Math.floor(rand() * 365 * 86_400_000);
    const hora = hh(Math.floor(rand() * 1440));
    const modo = rand() < 0.5 ? "fijo" : "eventual";
    const fServ = rand() < 0.3 ? null : new Date(ahora + (rand() * 200 - 100) * 86_400_000 - 5 * 3_600_000).toISOString().slice(0, 10);
    const f = fechaReferencia({ modoServicio: modo, fechaServicio: fServ, horaSalida: hora, sentido: "ida", ahoraMs: ahora });
    if (!f.ok) { pasadas++; continue; }
    const v = validarSalida(f.fecha, hora, ahora);
    if (!v.ok) { pasadas++; console.log("   mala:", new Date(ahora).toISOString(), modo, fServ, hora, JSON.stringify(f), JSON.stringify(v)); } else validas++;
    if (modo === "fijo") {
      const dow = new Date(`${f.fecha}T12:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) pasadas++;
    }
  }
  chk("la salida de referencia siempre se puede consultar (futura, ≤ 90 días) y el fijo cae en hábil", pasadas === 0, `${pasadas} malas`);
  chk("COROLARIO: produce fechas válidas", validas === 3000);
}

// ── Una hora que puso el SISTEMA no es un dato: «solo vacías» la recalcula ─────────────
{
  const viejo = { ...CALC, hora: "06:20", firma: "otra" };
  const calcSistema = { ...P("b", "intermedia", "06:20"), hora_calc: viejo };
  const manual = P("c", "intermedia", "06:45");
  const editada = { ...P("d", "destino", "07:30"), hora_calc: { ...CALC, hora: "07:10" } };
  chk("horaFijaDe: hora calculada (aunque desactualizada) no es fija", horaFijaDe(calcSistema, "vacias") === null);
  chk("horaFijaDe: hora escrita a mano es fija", horaFijaDe(manual, "vacias") === "06:45");
  chk("horaFijaDe: calculada y luego editada a mano es fija", horaFijaDe(editada, "vacias") === "07:30");
  chk("horaFijaDe: en «todas» nada es fijo", horaFijaDe(manual, "todas") === null);
  const r = planHoras({ paradas: [P("a", "inicio", "06:00"), calcSistema, manual, editada], tramosS: [600, 600, 600], esperaMin: 0, modo: "vacias", calc: CALC });
  chk("vacías: recalcula la hora del sistema (06:10, no 06:20)", r.filas[1].hora === "06:10" && r.filas[1].codigo === "calculada");
  chk("vacías: conserva la escrita a mano", r.filas[2].hora === "06:45" && r.filas[2].codigo === "conservada_manual");
  const t = planHoras({ paradas: [P("a", "inicio", "06:00"), calcSistema, manual, editada], tramosS: [600, 600, 600], esperaMin: 0, modo: "todas", calc: CALC });
  chk("todas: «pisaria» solo cuenta las horas escritas por una persona", t.pisaria === 2, `pisaria=${t.pisaria}`);
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todas las pruebas pasaron");
process.exit(fallos ? 1 : 0);
