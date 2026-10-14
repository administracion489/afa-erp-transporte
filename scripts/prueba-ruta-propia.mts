// Pruebas de la RUTA PROPIA (lib/ruta-propia.ts): la línea de la ruta planificada armada con el
// GPS real de un servicio anterior, que el modal GPS dibuja desde el día 31 en vez de volver a
// pagarle a Google. NO tocan la base: trazas sintéticas contra el motor puro.
// Uso:  npx tsx scripts/prueba-ruta-propia.mts   (sale con código 1 si algo falla)
//
// Lo que fija:
//   1. emparejar paraderos: en orden, a ≤ radio, el punto más cercano de la pasada;
//   2. los cuatro rechazos (pocos puntos, no pasa un paradero, con huecos, impreciso);
//   3. entre los válidos gana el MÁS CORTO (un desvío alarga), a igual largo el más reciente;
//   4. el payload tiene la forma de /api/ruta: [lng, lat], un tramo por par de paraderos, km
//      medidos sobre la traza completa y duraciones de las horas del servicio;
//   5. simplificar conserva los paraderos y los extremos, respeta el tope de vértices y no se
//      aparta de la traza más que la tolerancia final;
//   6. mismosParaderos / debeReconstruir / payloadServible;
//   7. por barrido: un válido SIEMPRE pasa por todos los paraderos a ≤ radio y sin saltos, y su
//      corolario (el barrido sí produce válidos y rechazos).
import {
  emparejarParaderos, juzgarTrazo, elegirRecorrido, payloadDeRecorrido, simplificar, mismosParaderos,
  debeReconstruir, payloadServible, RADIO_PARADERO_M, MAX_SALTO_M, MAX_VERTICES, DIAS_RENOVAR, HORAS_REINTENTO,
  type Candidato, type Punto, type CodigoTrazo,
} from "../lib/ruta-propia";
import { distM, type HuellaPt } from "../lib/huella";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// Una recta hacia el sur con un paradero cada ~2 km. Puntos cada ~50 m (0.00045° ≈ 50 m).
const LAT0 = -12.10, LNG0 = -77.03;
const PASO = 0.00045;
const paraderos: Punto[] = [0, 40, 80].map((k) => ({ lat: LAT0 - k * PASO, lng: LNG0 }));
const T0 = Date.parse("2026-09-10T06:00:00-05:00");

/** Traza de n puntos hacia el sur, cada 50 m y 10 s, con un desplazamiento lateral opcional. */
function traza(n: number, opts: { acc?: number; lateral?: (i: number) => number; saltoEn?: number; desde?: number } = {}): HuellaPt[] {
  const out: HuellaPt[] = [];
  let extra = 0;
  for (let i = 0; i < n; i++) {
    if (opts.saltoEn != null && i === opts.saltoEn) extra += 10;   // +10 pasos de golpe (~500 m)
    const k = (opts.desde ?? 0) + i + extra;
    out.push({
      lat: LAT0 - k * PASO,
      lng: LNG0 + (opts.lateral ? opts.lateral(i) : 0),
      velocidad: 18, acc: opts.acc ?? 6, ts: T0 + i * 10_000,
    });
  }
  return out;
}

// ── 1. Emparejar ──────────────────────────────────────────────────────────────
{
  const t = traza(85);
  const em = emparejarParaderos(t, paraderos);
  chk("1a encuentra los tres paraderos", "indices" in em && em.indices.length === 3);
  if ("indices" in em) chk("1b el punto más cercano de cada pasada", em.indices[0] === 0 && em.indices[1] === 40 && em.indices[2] === 80, JSON.stringify(em.indices));
  const alReves = emparejarParaderos(t, [...paraderos].reverse());
  chk("1c en orden inverso no empareja (el orden importa)", "falta" in alReves);
  const corta = emparejarParaderos(traza(50), paraderos);
  chk("1d una traza que no llega al último dice cuál falta", "falta" in corta && corta.falta === 2);
}

// ── 2. Rechazos ───────────────────────────────────────────────────────────────
{
  chk("2a pocos puntos", juzgarTrazo(traza(5), paraderos).codigo === "pocos_puntos");
  chk("2b no pasa un paradero", juzgarTrazo(traza(60), paraderos).codigo === "no_pasa_paradero");
  const hueco = juzgarTrazo(traza(75, { saltoEn: 30 }), paraderos);
  chk("2c un salto de > 300 m es un hueco", hueco.codigo === "con_huecos" && (hueco as { saltoM?: number }).saltoM! > MAX_SALTO_M);
  chk("2d precisión mediana de torre: impreciso", juzgarTrazo(traza(85, { acc: 60 }), paraderos).codigo === "impreciso");
  const lejos = traza(85, { lateral: () => 0.003 });   // ~330 m al costado de los paraderos
  chk("2e a 330 m del paradero no cuenta como pasar", juzgarTrazo(lejos, paraderos).codigo === "no_pasa_paradero");
  const ok = juzgarTrazo(traza(85), paraderos);
  chk("2f una traza limpia es válida", ok.codigo === "ok");
  // Puntos ANTES del paradero 1 y DESPUÉS del último no entran a la línea.
  const conCola = juzgarTrazo(traza(100, { desde: -10 }), paraderos);
  chk("2g se recorta del paradero 1 al último", conCola.codigo === "ok" && conCola.puntos.length === 81, conCola.codigo === "ok" ? String(conCola.puntos.length) : conCola.codigo);
}

// ── 3. Elegir el más corto ────────────────────────────────────────────────────
{
  const recto: Candidato = { reservaId: 1, fecha: "2026-09-01", puntos: traza(85) };
  // Un desvío: se va 150 m al costado entre los paraderos 1 y 2 (alarga, sigue pasando por todos).
  const desvio: Candidato = { reservaId: 2, fecha: "2026-09-20", puntos: traza(85, { lateral: (i) => (i > 10 && i < 30 ? 0.0012 : 0) }) };
  const roto: Candidato = { reservaId: 3, fecha: "2026-09-25", puntos: traza(75, { saltoEn: 30 }) };
  const e = elegirRecorrido([desvio, roto, recto], paraderos);
  chk("3a gana el recto aunque el desvío sea más reciente", e.ok && e.reservaId === 1);
  chk("3b los rechazos se cuentan por código", e.descartes.con_huecos === 1 && e.juzgados === 3);
  const gemelo: Candidato = { reservaId: 4, fecha: "2026-09-28", puntos: traza(85) };
  const e2 = elegirRecorrido([recto, gemelo], paraderos);
  chk("3c a igual largo gana el más reciente", e2.ok && e2.reservaId === 4);
  const nada = elegirRecorrido([roto], paraderos);
  chk("3d sin válidos no hay elección", !nada.ok && nada.descartes.con_huecos === 1);
  chk("3e sin candidatos no hay elección", !elegirRecorrido([], paraderos).ok);
}

// ── 4. Payload con la forma de /api/ruta ──────────────────────────────────────
{
  const e = elegirRecorrido([{ reservaId: 7, fecha: "2026-09-05", puntos: traza(85) }], paraderos);
  if (!e.ok) { chk("4 hay elección", false); }
  else {
    const p = payloadDeRecorrido(e, ["A", "B", "C"]);
    chk("4a coordenadas [lng, lat]", Math.abs(p.coordenadas[0][0] - LNG0) < 1e-6 && Math.abs(p.coordenadas[0][1] - LAT0) < 1e-6);
    chk("4b un tramo por par de paraderos, con sus nombres", p.tramos.length === 2 && p.tramos[0].desde === "A" && p.tramos[1].hasta === "C");
    chk("4c km medidos (~2 km por tramo)", Math.abs(p.tramos[0].distancia_km - 2.0) <= 0.1 && Math.abs(p.total_km - 4.0) <= 0.2, `${p.tramos[0].distancia_km} / ${p.total_km}`);
    chk("4d duración de las horas del servicio (40 × 10 s ≈ 7 min)", p.tramos[0].duracion_s === 400 && p.tramos[0].duracion_min === 7, String(p.tramos[0].duracion_s));
    chk("4e declara la fuente y la fecha, sin el id de la otra reserva", p.fuente === "propia" && p.fuente_fecha === "2026-09-05" && !("fuente_reserva_id" in p) && e.reservaId === 7);
    chk("4f una recta se simplifica a pocos vértices (paraderos + extremos)", p.coordenadas.length <= 5, String(p.coordenadas.length));
    // Sin horas (ts 0) la duración no se inventa.
    const sinTs = elegirRecorrido([{ reservaId: 8, fecha: null, puntos: traza(85).map((q) => ({ ...q, ts: 0 })) }], paraderos);
    if (sinTs.ok) {
      const q = payloadDeRecorrido(sinTs, []);
      chk("4g sin horas: duración 0 y texto —, nombres de respaldo", q.tramos[0].duracion_s === 0 && q.tramos[0].duracion_texto === "—" && q.tramos[0].desde === "Punto 1");
    }
  }
}

// ── 5. Simplificar ────────────────────────────────────────────────────────────
{
  // Zigzag de 5000 puntos: no cabe con la tolerancia base.
  const zz: Punto[] = Array.from({ length: 5000 }, (_, i) => ({ lat: LAT0 - i * 0.00002, lng: LNG0 + (i % 2 ? 0.0003 : 0) }));
  const oblig = [0, 1234, 2500, 4999];
  const q = simplificar(zz, oblig);
  chk("5a respeta el tope de vértices", q.length <= MAX_VERTICES, String(q.length));
  chk("5b conserva los obligados y los extremos", oblig.every((i) => q.includes(i)));
  chk("5c índices en orden y sin repetir", q.every((v, i) => i === 0 || v > q[i - 1]));
  // Una curva suave: el resultado no se aparta de la traza más de unos metros.
  const curva: Punto[] = Array.from({ length: 400 }, (_, i) => ({ lat: LAT0 - i * PASO * 0.2, lng: LNG0 + Math.sin(i / 60) * 0.004 }));
  const qc = simplificar(curva, []);
  let peor = 0;
  for (let s = 0; s < qc.length - 1; s++) {
    const a = curva[qc[s]], b = curva[qc[s + 1]];
    for (let i = qc[s] + 1; i < qc[s + 1]; i++) {
      // Distancia aproximada del punto al segmento a-b, muestreando el segmento.
      let m = Infinity;
      for (let t = 0; t <= 200; t++) {
        const x = { lat: a.lat + (b.lat - a.lat) * t / 200, lng: a.lng + (b.lng - a.lng) * t / 200 };
        m = Math.min(m, distM(curva[i].lat, curva[i].lng, x.lat, x.lng));
      }
      peor = Math.max(peor, m);
    }
  }
  chk("5d la curva simplificada no se aparta más de ~5 m", peor <= 5, `${peor.toFixed(2)} m con ${qc.length} vértices`);
  chk("5e dos puntos quedan como están", simplificar([zz[0], zz[1]], []).length === 2);
}

// ── 6. Utilidades ─────────────────────────────────────────────────────────────
{
  const corridos = paraderos.map((p) => ({ lat: p.lat + 0.0005, lng: p.lng }));   // ~55 m
  chk("6a mismosParaderos tolera el radio", mismosParaderos(paraderos, corridos));
  chk("6b distinto largo no son los mismos", !mismosParaderos(paraderos, paraderos.slice(0, 2)));
  chk("6c a 500 m no son los mismos", !mismosParaderos(paraderos, paraderos.map((p) => ({ lat: p.lat + 0.0045, lng: p.lng }))));
  const ahora = Date.parse("2026-10-14T12:00:00Z");
  const hace = (h: number) => new Date(ahora - h * 3_600_000).toISOString();
  const pay = { coordenadas: [[0, 0], [1, 1]], tramos: [] } as never;
  chk("6d sin fila: se arma", debeReconstruir(null, ahora));
  chk("6e con ruta reciente: no", !debeReconstruir({ payload: pay, revisada_en: hace(24 * 5) }, ahora));
  chk("6f con ruta de más de 30 días: se renueva", debeReconstruir({ payload: pay, revisada_en: hace(24 * DIAS_RENOVAR) }, ahora));
  chk("6g intento fallido reciente: espera", !debeReconstruir({ payload: null, revisada_en: hace(HORAS_REINTENTO - 1) }, ahora));
  chk("6h intento fallido de ayer: reintenta", debeReconstruir({ payload: null, revisada_en: hace(HORAS_REINTENTO) }, ahora));
  chk("6i revisada_en ilegible: se arma", debeReconstruir({ payload: pay, revisada_en: "x" }, ahora));
  chk("6j payloadServible exige coordenadas", payloadServible({ payload: pay, revisada_en: null }) != null
    && payloadServible({ payload: null, revisada_en: null }) == null
    && payloadServible({ payload: { coordenadas: [[0, 0]], tramos: [] } as never, revisada_en: null }) == null);
}

// ── 7. Barrido ────────────────────────────────────────────────────────────────
{
  const vistos = new Set<CodigoTrazo>();
  let violaciones = 0, n = 0;
  for (const largo of [5, 30, 60, 85, 100])
    for (const acc of [4, 15, 25, 80])
      for (const lat of [0, 0.0008, 0.0016, 0.003])
        for (const salto of [null, 20, 50])
          for (const desde of [-5, 0, 3]) {
            n++;
            const t = traza(largo, { acc, lateral: () => lat, saltoEn: salto ?? undefined, desde });
            const r = juzgarTrazo(t, paraderos);
            vistos.add(r.codigo);
            if (r.codigo !== "ok") continue;
            const pasa = paraderos.every((p, k) => distM(r.puntos[r.indices[k]].lat, r.puntos[r.indices[k]].lng, p.lat, p.lng) <= RADIO_PARADERO_M);
            let sinSalto = true;
            for (let i = 1; i < r.puntos.length; i++) if (distM(r.puntos[i - 1].lat, r.puntos[i - 1].lng, r.puntos[i].lat, r.puntos[i].lng) > MAX_SALTO_M) sinSalto = false;
            const enOrden = r.indices.every((v, i) => i === 0 || v >= r.indices[i - 1]);
            if (!pasa || !sinSalto || !enOrden || r.indices[0] !== 0 || r.indices.at(-1) !== r.puntos.length - 1) violaciones++;
          }
  chk(`7a ${n} trazas: todo válido pasa por cada paradero, en orden, sin saltos`, violaciones === 0, `${violaciones} violaciones`);
  chk("7b corolario: salen los cinco códigos", vistos.size === 5, [...vistos].join(","));
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
