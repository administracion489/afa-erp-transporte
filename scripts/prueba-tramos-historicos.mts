// Pruebas del tiempo REAL por tramo (lib/tramos-historicos.ts): lo que el modal GPS enseña por
// defecto en vez de pagarle a Google. NO tocan la base: datos en memoria contra el motor puro.
// Uso:  npx tsx scripts/prueba-tramos-historicos.mts   (sale con código 1 si algo falla)
//
// Lo que fija:
//   1. la mediana (no la media) de llegada a llegada, y que un servicio aporta UNA muestra;
//   2. el tramo se reconoce por la POSICIÓN (≤ 150 m), consecutivo, sin importar el nombre;
//   3. lo imposible se descarta y se cuenta (marcado en lote, marca olvidada);
//   4. la franja horaria manda; sin MIN_MUESTRAS en la franja, el día entero y se dice;
//   5. con menos de MIN_MUESTRAS no hay número, y el total solo es completo con todos;
//   6. sin coordenadas no se busca; (0,0) no es un paradero;
//   7. minutosRestantes: fracción acotada al tramo, nunca más que el tramo;
//   8. por barrido: invariantes (número ⟺ código con número, muestras ≥ MIN, minutos ≥ piso
//      físico) y su corolario (salen los cuatro códigos).
import {
  tiemposPorTramo, muestrasDeTramo, minutosRestantes, mediana, horaAMin, minutoLima, difMinutosDia,
  MIN_MUESTRAS, RADIO_MATCH_M, VEL_MAX_KMH, DUR_MAX_MIN, FRANJA_MIN,
  type ServicioHistorico, type PuntoRuta, type CodigoTramo,
} from "../lib/tramos-historicos";
import { distM } from "../lib/huella";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// Paraderos de la ruta (Panamericana Sur, de la captura del caso).
const A = { lat: -12.3214, lng: -76.8208 };   // BSF Punta Hermosa
const B = { lat: -12.3575, lng: -76.7810 };   // Ctra. Panamericana Sur
const C = { lat: -12.3800, lng: -76.7720 };   // El Bosque, Punta Negra
const ruta: PuntoRuta[] = [{ ...A, hora: "05:50" }, { ...B }, { ...C }];

// Instante Lima de un día y hora.
const ts = (dia: number, hhmm: string) => Date.parse(`2026-10-${String(dia).padStart(2, "0")}T${hhmm}:00-05:00`);
let rid = 1000;
const servicio = (llegadas: (number | null)[], puntos = [A, B, C]): ServicioHistorico => ({
  reservaId: rid++,
  paradas: puntos.map((p, i) => ({ ...p, llegadaTs: llegadas[i] ?? null })),
});
const mas = (t: number, min: number) => t + min * 60_000;

// ── 1. Mediana y una muestra por servicio ───────────────────────────────────
{
  rid = 1000;
  const hs = [9, 10, 11, 12, 30].map((m, d) => { const t0 = ts(d + 1, "05:50"); return servicio([t0, mas(t0, m), mas(t0, m + 5)]); });
  const r = tiemposPorTramo(ruta, hs);
  chk("1a mediana, no media (9,10,11,12,30 → 11)", r.tramos[0].minutos === 11, String(r.tramos[0].minutos));
  chk("1b segundo tramo 5 min", r.tramos[1].minutos === 5);
  chk("1c total completo = suma", r.completo && r.totalMin === 16, `${r.totalMin}`);
  chk("1d servicios distintos que aportan", r.servicios === 5);
  chk("1e mediana par", mediana([1, 3, 5, 100]) === 4);
  // Un servicio que repite el tramo dos veces aporta UNA muestra (la primera).
  const t0 = ts(7, "05:50");
  const rep = servicio([t0, mas(t0, 10), t0 + 9e9, t0 + 9e9 + 60_000 * 40], [A, B, A, B]);
  chk("1f una muestra por servicio", muestrasDeTramo(A, B, [rep]).validas.length === 1);
}

// ── 2. Reconocer por posición, consecutivo ──────────────────────────────────
{
  const t0 = ts(1, "05:50");
  const cerca = { lat: A.lat + 0.001, lng: A.lng };    // ~111 m
  const lejos = { lat: A.lat + 0.002, lng: A.lng };    // ~222 m
  chk("2a radio heredado 150", RADIO_MATCH_M === 150);
  chk("2b paradero a ~111 m calza", muestrasDeTramo(A, B, [servicio([t0, mas(t0, 10)], [cerca, B])]).validas.length === 1);
  chk("2c paradero a ~222 m no calza", muestrasDeTramo(A, B, [servicio([t0, mas(t0, 10)], [lejos, B])]).validas.length === 0);
  const X = { lat: -12.34, lng: -76.80 };
  chk("2d con un paradero intermedio no es el tramo", muestrasDeTramo(A, B, [servicio([t0, mas(t0, 5), mas(t0, 12)], [A, X, B])]).validas.length === 0);
  chk("2e en sentido contrario no es el tramo", muestrasDeTramo(A, B, [servicio([t0, mas(t0, 10)], [B, A])]).validas.length === 0);
}

// ── 3. Lo imposible se descarta y se cuenta ─────────────────────────────────
{
  const t0 = ts(1, "05:50");
  const rectaMin = distM(A.lat, A.lng, B.lat, B.lng) / (VEL_MAX_KMH / 3.6) / 60;
  const lote = servicio([t0, t0 + 20_000]);                       // marcado en lote: 20 s
  const rapido = servicio([t0, mas(t0, rectaMin * 0.8)]);          // más rápido que 90 km/h
  const olvido = servicio([t0, mas(t0, DUR_MAX_MIN + 1)]);         // 3 h 1 min
  const negativo = servicio([mas(t0, 10), t0]);                    // marcado al revés
  const m = muestrasDeTramo(A, B, [lote, rapido, olvido, negativo]);
  chk("3a ninguno es una medición", m.validas.length === 0);
  chk("3b los cuatro se cuentan como descartados", m.descartadas === 4, String(m.descartadas));
  const r = tiemposPorTramo(ruta, [lote, rapido, olvido]);
  chk("3c sin número y el detalle lo dice", r.tramos[0].minutos == null && /descartaron/.test(r.tramos[0].detalle));
  chk("3d una hora faltante no es descarte", muestrasDeTramo(A, B, [servicio([t0, null])]).descartadas === 0);
}

// ── 4. Franja horaria ───────────────────────────────────────────────────────
{
  rid = 2000;
  const manana = [10, 10, 11].map((m, d) => { const t0 = ts(d + 1, "05:45"); return servicio([t0, mas(t0, m)]); });
  const tarde = [25, 26, 27, 28].map((m, d) => { const t0 = ts(d + 1, "17:30"); return servicio([t0, mas(t0, m)]); });
  const r = tiemposPorTramo(ruta.slice(0, 2), [...manana, ...tarde]);
  chk("4a a las 05:50 usa la mañana (franja)", r.tramos[0].codigo === "franja" && r.tramos[0].minutos === 10, `${r.tramos[0].codigo} ${r.tramos[0].minutos}`);
  const r2 = tiemposPorTramo([{ ...A, hora: "17:40" }, B], [...manana, ...tarde]);
  chk("4b a las 17:40 usa la tarde", r2.tramos[0].minutos === 26.5, String(r2.tramos[0].minutos));
  const r3 = tiemposPorTramo([{ ...A, hora: "12:00" }, B], [...manana, ...tarde]);
  chk("4c sin franja → todo el día y se dice", r3.tramos[0].codigo === "todo_el_dia" && /cualquier hora/.test(r3.tramos[0].detalle));
  const r4 = tiemposPorTramo([{ ...A }, B], [...manana, ...tarde], { horaServicio: "05:40:00" });
  chk("4d sin hora del paradero usa la del servicio", r4.tramos[0].codigo === "franja" && r4.tramos[0].minutos === 10);
  chk("4e la franja cruza la medianoche", difMinutosDia(horaAMin("23:50")!, horaAMin("00:10")!) === 20);
  chk("4f minutoLima", minutoLima(ts(3, "05:50")) === 350);
  chk("4g franja declarada 90", FRANJA_MIN === 90);
}

// ── 5. Pocos datos y total ──────────────────────────────────────────────────
{
  const t0 = ts(1, "05:50");
  const dos = [servicio([t0, mas(t0, 10)]), servicio([t0, mas(t0, 11)])];
  const r = tiemposPorTramo(ruta.slice(0, 2), dos);
  chk("5a con 2 muestras no hay número", r.tramos[0].codigo === "pocos_datos" && r.tramos[0].minutos == null && r.tramos[0].muestrasDia === 2);
  chk("5b MIN_MUESTRAS = 3", MIN_MUESTRAS === 3);
  const tres = [...dos, servicio([t0, mas(t0, 12)])];
  const r2 = tiemposPorTramo(ruta, tres);   // B→C sin datos
  chk("5c total parcial no es completo", !r2.completo && r2.conNumero === 1 && r2.totalMin === 11);
  chk("5d sin historial: detalle honesto", /Sin servicios finalizados/.test(r2.tramos[1].detalle));
  const r3 = tiemposPorTramo(ruta, []);
  chk("5e sin historial: total null", r3.totalMin == null && !r3.completo);
}

// ── 6. Coordenadas ──────────────────────────────────────────────────────────
{
  const t0 = ts(1, "05:50");
  const hs = [10, 11, 12].map((m) => servicio([t0, mas(t0, m)]));
  const r = tiemposPorTramo([{ lat: null, lng: null }, B], hs);
  chk("6a sin coordenadas no se busca", r.tramos[0].codigo === "sin_coordenadas" && r.tramos[0].rectaM == null);
  const cero = servicio([t0, mas(t0, 10)], [{ lat: 0, lng: 0 }, B]);
  chk("6b (0,0) no calza con nada", muestrasDeTramo({ lat: 0.0001, lng: 0 }, B, [cero]).validas.length === 0);
  chk("6c lat/lng en texto se aceptan", muestrasDeTramo(A, B, [{ reservaId: 1, paradas: [{ lat: String(A.lat) as unknown as number, lng: String(A.lng) as unknown as number, llegadaTs: t0 }, { ...B, llegadaTs: mas(t0, 10) }] }]).validas.length === 1);
  chk("6d una sola parada: sin tramos", tiemposPorTramo([A], hs).tramos.length === 0);
}

// ── 7. minutosRestantes ─────────────────────────────────────────────────────
{
  chk("7a mitad del tramo → mitad del tiempo", minutosRestantes(10, 500, 1000) === 5);
  chk("7b más lejos que el tramo → el tramo entero, nunca más", minutosRestantes(10, 5000, 1000) === 10);
  chk("7c en el paradero → 0", minutosRestantes(10, 0, 1000) === 0);
  chk("7d sin duración → null", minutosRestantes(null, 500, 1000) == null);
  chk("7e sin distancia del tramo → null", minutosRestantes(10, 500, 0) == null && minutosRestantes(10, 500, null) == null);
  chk("7f sin distancia restante → null", minutosRestantes(10, null, 1000) == null);
}

// ── 8. Barrido ──────────────────────────────────────────────────────────────
{
  const vistos = new Set<CodigoTramo>();
  let casos = 0, malos = 0;
  const durs = [0.2, 3, 6, 9, 15, 40, 200];
  const horas = ["05:00", "05:50", "12:00", "17:30", null];
  for (let n = 0; n <= 10; n++) for (const hora of horas) for (let semilla = 0; semilla < 7; semilla++) for (const sinCoord of [false, true]) {
    const hs: ServicioHistorico[] = [];
    for (let k = 0; k < n; k++) {
      const t0 = ts(1 + k, k % 2 ? "05:45" : "17:20");
      const d = durs[(k + semilla) % durs.length];
      hs.push(servicio([t0, mas(t0, d), mas(t0, d * 2)]));
    }
    const rr: PuntoRuta[] = [{ ...(sinCoord ? { lat: null, lng: null } : A), hora }, B, C];
    const r = tiemposPorTramo(rr, hs);
    casos++;
    for (const t of r.tramos) {
      vistos.add(t.codigo);
      const conNumero = t.codigo === "franja" || t.codigo === "todo_el_dia";
      if ((t.minutos != null) !== conNumero) malos++;
      if (conNumero && t.muestras < MIN_MUESTRAS) malos++;
      if (conNumero && t.rectaM != null && t.minutos! * 60 < t.rectaM / (VEL_MAX_KMH / 3.6) - 6) malos++;
      if (conNumero && t.minutos! > DUR_MAX_MIN) malos++;
      if (t.muestras > t.muestrasDia && t.codigo !== "franja") malos++;
    }
    if (r.completo !== (r.tramos.length > 0 && r.tramos.every((t) => t.minutos != null))) malos++;
    if ((r.totalMin == null) !== (r.conNumero === 0)) malos++;
  }
  chk(`8a invariantes en ${casos} combinaciones`, malos === 0, `${malos} violaciones`);
  chk("8b salen los cuatro códigos", vistos.size === 4, [...vistos].join(","));
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
