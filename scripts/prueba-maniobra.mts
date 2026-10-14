// scripts/prueba-maniobra.mts — la regla «maniobra vs. recta en marcha» de la huella (lib/huella.ts,
// fixEnRectaEnMarcha, caso #1298). Correr: npx tsx scripts/prueba-maniobra.mts
//
// Un fix de chip que Map Matching no pegó se dibuja como medido SALVO que sea extremo de una recta
// de más de MAX_SEG_CRUDO_M recorrida a más de VEL_MANIOBRA_KMH: esa recta cortaría manzanas y el
// tramo se rellena por la vía. Lenta (cochera, patio) o corta (posiciones densas) → medida.

import * as H from "../lib/huella";

let fallos = 0;
const chk = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "  ok  " : "FALLA "} ${n}${extra ? " — " + extra : ""}`); if (!ok) fallos++; };

const LAT = -12.03, LNG = -76.99, T0 = Date.parse("2026-10-14T05:20:00-05:00");
const M_LAT = 1 / 111_320;   // grados de latitud por metro
/** Fix a `m` metros al norte del origen, en el segundo `s`, con precisión `acc`. */
const fix = (m: number, s: number, acc = 5) => ({ lat: LAT + m * M_LAT, lng: LNG, acc, ts: T0 + s * 1000, velocidad: 0 });

// ── 1. La regla, cuerda por cuerda ────────────────────────────────────────────
{
  chk("1a cochera: 100 m en 60 s (6 km/h) es maniobra", !H.fixEnRectaEnMarcha([fix(0, 0), fix(100, 60)], 1));
  chk("1b en marcha: 100 m en 10 s (36 km/h) cortaría manzanas", H.fixEnRectaEnMarcha([fix(0, 0), fix(100, 10)], 1) && H.fixEnRectaEnMarcha([fix(0, 0), fix(100, 10)], 0));
  chk("1c densa: 40 m en 3 s (48 km/h) sigue la calle sola", !H.fixEnRectaEnMarcha([fix(0, 0), fix(40, 3)], 1));
  chk("1d justo en 60 m no cuenta (el corte es «más de»)", !H.fixEnRectaEnMarcha([fix(0, 0), fix(H.MAX_SEG_CRUDO_M - 0.01, 2)], 1));
  chk("1e justo en 10 km/h no cuenta", !H.fixEnRectaEnMarcha([fix(0, 0), fix(100, 36)], 1));
  const sinHora = [{ ...fix(0, 0), ts: undefined }, { ...fix(100, 10), ts: undefined }];
  chk("1f sin hora no se juzga (comportamiento de siempre)", !H.fixEnRectaEnMarcha(sinHora, 0) && !H.fixEnRectaEnMarcha(sinHora, 1));
  chk("1g horas desordenadas no se juzgan", !H.fixEnRectaEnMarcha([fix(0, 10), fix(100, 0)], 1));
  // El fix del medio: lento hacia atrás, rápido hacia adelante → es extremo de una recta en marcha.
  const tres = [fix(0, 0), fix(30, 60), fix(150, 70)];
  chk("1h basta UNA cuerda vecina en marcha", H.fixEnRectaEnMarcha(tres, 1) && H.fixEnRectaEnMarcha(tres, 2) && !H.fixEnRectaEnMarcha(tres, 0));
  chk("1i el umbral es el de la regla del dueño (10 km/h)", H.VEL_MANIOBRA_KMH === 10);
}

// ── 2. Ventana que Map Matching no pegó: qué se dibuja ────────────────────────
{
  const sinMatch = async () => new Response(JSON.stringify({ code: "NoMatch" }), { status: 422 });
  // Sale de la cochera despacio (maniobra) y después va en marcha con posiciones cada 150 m.
  const pts = [fix(0, 0), fix(20, 30), fix(45, 60), fix(195, 75), fix(345, 90), fix(495, 105)];
  const r = await H.matchVentana(pts, "tok", sinMatch);
  const coords = r.coords;
  const lineas = H.colorearMatched(coords, pts as any, [], r.esCrudo) as any[];
  const largo = (f: any) => { const [[x1, y1], [x2, y2]] = f.geometry.coordinates; return H.distM(y1, x1, y2, x2); };
  chk("2a no pegó: cae al crudo suavizado", !r.snapped && coords.length === pts.length);
  chk("2b la maniobra de la cochera queda medida", r.esCrudo[0] === false && r.esCrudo[1] === false);
  chk("2c las rectas en marcha quedan crudas", r.esCrudo.slice(2).every(Boolean));
  // #1609: si el tramo en marcha NO se pudo rellenar por la vía, se dibuja como medido (una recta
  // es mejor que un hueco que nadie rellena). Solo se oculta cuando su estimado sí se dibuja.
  const sinPuente = H.colorearMatched(coords, pts as any, [], r.esCrudo) as any[];
  chk("2d sin tramo estimado, la recta en marcha se dibuja (no queda un hueco)", sinPuente.length === coords.length - 1, `${sinPuente.length}/${coords.length - 1}`);
  const conPuente = H.colorearMatched(coords, pts as any, [[2, coords.length - 1]], r.esCrudo) as any[];
  chk("2d' con su tramo estimado dibujado, la recta no sale (no pasa por los techos)", conPuente.every((f) => largo(f) <= H.MAX_SEG_CRUDO_M + 0.5));
  void lineas;
  const puentes = H.puentesCrudos(coords, H.rangosDeCrudo(r.esCrudo, coords.length).crudoRanges.concat([]));
  chk("2e y el tramo en marcha se ofrece para rellenar por la vía (o queda como punta viva)", r.esCrudo.slice(2).every(Boolean) && puentes.every((p) => p.origen === "crudo"));
  // Un fix de RED largo sigue sin dibujarse aunque no haya estimado (la regla de siempre).
  const redLejos = [fix(0, 0, 40), fix(150, 15, 40)];
  const rRed = await H.matchVentana(redLejos, "tok", sinMatch);
  chk("2h fix de red a más de 60 m: sigue oculto sin estimado", (H.colorearMatched(rRed.coords, redLejos as any, [], rRed.esCrudo) as any[]).length === 0);
  // Sin precisión en la huella (llamador viejo): se oculta, como antes.
  const sinAcc = pts.map(({ acc, ...p }) => p);
  chk("2i huella sin precisión: la recta cruda se oculta como antes", (H.colorearMatched(coords, sinAcc as any, [], r.esCrudo) as any[]).length < coords.length - 1);
  // Con posiciones densas (cada 40 m a 48 km/h) nada cambia: el chip sigue la calle.
  const densa = Array.from({ length: 12 }, (_, i) => fix(i * 40, i * 3));
  const rd = await H.matchVentana(densa, "tok", sinMatch);
  chk("2f posiciones densas en marcha siguen medidas (protege el oro)", rd.esCrudo.every((x) => !x));
  // GPS de red: crudo por la precisión, como siempre.
  const red = Array.from({ length: 6 }, (_, i) => fix(i * 30, i * 60, 40));
  const rr = await H.matchVentana(red, "tok", sinMatch);
  chk("2g fix de red: crudo por la precisión, como antes", rr.esCrudo.every(Boolean));
}

// ── 3. Más tramos que el tope: la ruta prevista (gratis) los rellena TODOS (#1609) ──
{
  // Ruta recta al norte de 8 km; 40 corridas crudas de 150 m a lo largo de ella.
  const ruta: [number, number][] = Array.from({ length: 81 }, (_, i) => [LNG, LAT + i * 100 * M_LAT]);
  const cands = Array.from({ length: 40 }, (_, k) => {
    const a = k * 200, b = a + 150;
    return { aLat: LAT + a * M_LAT, aLng: LNG, bLat: LAT + b * M_LAT, bLng: LNG, dt: 0, dRecta: 150, iA: k * 3, iB: k * 3 + 2, origen: "crudo" as const };
  });
  const fixes = cands.map((c) => [{ lat: (c.aLat + c.bLat) / 2, lng: LNG }]);
  const f1 = H.puentesPorRutaPrevista(cands, fixes, ruta);
  chk("3a con 40 tramos (más que MAX_PUENTES) la ruta prevista rellena los 40", f1.slots.every(Boolean) && cands.length > H.MAX_PUENTES, `${f1.slots.filter(Boolean).length}/40`);
  chk("3b el tope queda solo para Google", f1.porGoogle.length === 0);
}

// ── 4. GPS en la pista = huella medida, no estimada (#1309) ──────────────────
{
  const M_LNG = 1 / (111_320 * Math.cos(LAT * Math.PI / 180));
  const P = (n: number, e = 0): [number, number] => [LNG + e * M_LNG, LAT + n * M_LAT];   // n m al norte, e m al este
  const huella = (pts: [number, number][], acc: number | undefined) => pts.map(([lng, lat]) => ({ lat, lng, velocidad: 40, ...(acc == null ? {} : { acc }) }));
  // Avenida recta al norte: los fixes van en la vía (con 4 m de ruido lateral).
  const via: [number, number][] = [P(0), P(600)];
  const recta: [number, number][] = [P(0), P(150, 4), P(300, -3), P(450, 2), P(600)];
  const c = { origen: "crudo" as const, iA: 0, iB: 4 };
  chk("4a avenida recta con fixes precisos: se queda MEDIDA", H.corridaCrudaEnLaVia(c, via, recta, huella(recta, 5)));
  chk("4b los mismos fixes de red: sigue el estimado", !H.corridaCrudaEnLaVia(c, via, recta, huella(recta, 40)));
  chk("4c huella sin precisión: sigue el estimado", !H.corridaCrudaEnLaVia(c, via, recta, huella(recta, undefined)));
  // La vía dobla en L (300 m al norte y 300 al este) y el fix del medio corta la esquina en diagonal.
  const viaL: [number, number][] = [P(0), P(300), P(300, 300)];
  const esquina: [number, number][] = [P(0), P(150, 150), P(300, 300)];
  chk("4d recta que corta la esquina sobre las casas: sigue el estimado", !H.corridaCrudaEnLaVia({ origen: "crudo", iA: 0, iB: 2 }, viaL, esquina, huella(esquina, 5)));
  chk("4e un hueco de señal nunca se juzga así", !H.corridaCrudaEnLaVia({ origen: "hueco" as any, iA: 0, iB: 4 }, via, recta, huella(recta, 5)));
  chk("4f separación: líneas iguales 0 m, paralelas a 30 m ≈ 30", H.separacionEntreLineas(via, via) < 0.5 && Math.abs(H.separacionEntreLineas(via, [P(0, 30), P(600, 30)]) - 30) < 1);
  // La punta (colaViva degradada): fixes precisos sobre la ruta → medida, no estimado.
  const matched: [number, number][] = [P(0), P(100)];
  const cola = [100, 250, 400, 550].map((n, i) => ({ lat: LAT + n * M_LAT, lng: LNG + (i % 2 ? 3 : -3) * M_LNG, velocidad: 40, acc: 5 }));
  const live = { lat: LAT + 600 * M_LAT, lng: LNG, velocidad: 40, acc: 5 };
  const rutaN: [number, number][] = [P(0), P(800)];
  const fCola = H.colaViva(matched, cola, live, rutaN, true);
  chk("4g punta precisa sobre la ruta: huella medida, sin estimado", fCola.length > 0 && fCola.every((f: any) => !f.properties?.estimado));
  const colaRed = cola.map((p) => ({ ...p, acc: 40 }));
  const fRed = H.colaViva(matched, colaRed, { ...live, acc: 40 }, rutaN, true);
  chk("4h punta de red: sigue por la ruta (estimado)", fRed.length === 1 && fRed[0].properties?.estimado === 1);
}

// ── 5. El fix preciso en la calle es por donde pasa la huella (#1609) ────────────
{
  const M_LNG = 1 / (111_320 * Math.cos(LAT * Math.PI / 180));
  // El suavizado de antes, copiado literal: la referencia de lo que NO debe cambiar.
  const suavViejo = <T extends { lat: number; lng: number }>(pts: T[], R = 40, K = 8): T[] => pts.map((p, i) => {
    let sLat = 0, sLng = 0, n = 0;
    const lo = Math.max(0, i - K), hi = Math.min(pts.length - 1, i + K);
    for (let j = lo; j <= hi; j++) if (H.distM(pts[j].lat, pts[j].lng, p.lat, p.lng) <= R) { sLat += pts[j].lat; sLng += pts[j].lng; n++; }
    return n ? { ...p, lat: sLat / n, lng: sLng / n } : p;
  });
  // Giro en L a 32 km/h (≈9 m/s), un fix cada 2 s: 60 m al norte y luego al este. El fix de la esquina.
  const esquina = [0, 18, 36, 54].map((n, i) => ({ lat: LAT + n * M_LAT, lng: LNG, acc: 2, ts: T0 + i * 2000, velocidad: 32 }))
    .concat([0, 18, 36, 54].map((e, i) => ({ lat: LAT + 60 * M_LAT, lng: LNG + e * M_LNG, acc: 2, ts: T0 + (4 + i) * 2000, velocidad: 32 })));
  const k = 4;   // el de la esquina
  const viejo = suavViejo(esquina)[k], nuevo = H.suavizarPorDistancia(esquina)[k];
  const dViejo = H.distM(esquina[k].lat, esquina[k].lng, viejo.lat, viejo.lng);
  const dNuevo = H.distM(esquina[k].lat, esquina[k].lng, nuevo.lat, nuevo.lng);
  chk("5a esquina: antes el fix de ±2 m quedaba DENTRO de la manzana", dViejo > 8, `${dViejo.toFixed(1)} m`);
  chk("5b ahora no sale de su error (máx 3 m)", dNuevo <= 3.01, `${dNuevo.toFixed(2)} m`);
  const sinAcc = esquina.map(({ acc, ...p }) => p);
  chk("5c sin precisión: byte a byte el suavizado de antes", JSON.stringify(H.suavizarPorDistancia(sinAcc)) === JSON.stringify(suavViejo(sinAcc)));
  const sinHora = esquina.map(({ ts, ...p }) => p);
  chk("5d sin hora: byte a byte el de antes", JSON.stringify(H.suavizarPorDistancia(sinHora)) === JSON.stringify(suavViejo(sinHora)));
  const redEsq = esquina.map((p) => ({ ...p, acc: 40 }));
  chk("5e fix de red: byte a byte el de antes (su zigzag sí se aplana)", JSON.stringify(H.suavizarPorDistancia(redEsq)) === JSON.stringify(suavViejo(redEsq)));
  const lenta = esquina.map((p, i) => ({ ...p, ts: T0 + i * 60_000 }));   // la misma geometría en una cochera
  chk("5f maniobra lenta: byte a byte el de antes", JSON.stringify(H.suavizarPorDistancia(lenta)) === JSON.stringify(suavViejo(lenta)));

  // El radio de búsqueda: un chip de ±2 m busca vía a 15 m (antes 5), los de red no cambian.
  chk("5g radio de un fix de ±2 m: 15 m", H.radioDeBusqueda(2) === 15 && H.RADIO_MIN_MATCH_M === 15);
  chk("5h radio de red: igual que antes (acc·1.5, techo 50)", H.radioDeBusqueda(30) === 45 && H.radioDeBusqueda(100) === 50 && H.radioDeBusqueda(undefined) === 38);

  // Mapbox parte el trazo en dos fragmentos y deja SIN pareja el fix de la frontera (el preciso).
  const pts = Array.from({ length: 9 }, (_, i) => fix(i * 18, i * 2, 2));
  const geo = (desde: number, hasta: number, corr = 0) => Array.from({ length: hasta - desde + 1 }, (_, j) => [LNG + corr * M_LNG, LAT + (desde + j) * 18 * M_LAT] as [number, number]);
  const resp = (tp: any[], matchings: any[]) => async (url: string) => {
    (resp as any).ultima = url;
    return new Response(JSON.stringify({ code: "Ok", matchings, tracepoints: tp }), { status: 200 });
  };
  const tp = [0, 0, 0, null, 1, 1, null, 1, 1].map((m) => (m == null ? null : { matchings_index: m }));
  const mm = [{ confidence: 0.9, geometry: { coordinates: geo(0, 2, 1) } }, { confidence: 0.9, geometry: { coordinates: geo(4, 8, 1) } }];   // la vía, a 1 m de los fixes
  const r = await H.mapMatchTrail(pts, "tok", resp(tp, mm));
  const hay = (p: { lat: number; lng: number }) => !!r?.coords.some(([x, y]) => x === p.lng && y === p.lat);
  chk("5i el fix sin pareja de la FRONTERA entra a la huella (la línea pasa por él)", !!r && hay(pts[3]));
  chk("5j el sin pareja DENTRO de un fragmento no (tidy lo quitó por redundante)", !!r && !hay(pts[6]));
  chk("5k las métricas de suciedad no cambian por él (crudeFrac 0)", !!r && r.crudeFrac === 0 && r.confidence === 7 / 9);
  const urlRadios = String((resp as any).ultima).match(/radiuses=([^&]*)/)?.[1] ?? "";
  chk("5l a Mapbox viaja el radio de 15 m", urlRadios.split(";").every((x) => x === "15"), urlRadios);

  // Dos fragmentos SIN nada entre medio y 90 m de junta recta: sus extremos pasan a crudo.
  const tp2 = [0, 0, 0, 0, 1, 1, 1, 1, 1].map((m) => ({ matchings_index: m }));
  const mm2 = [{ confidence: 0.9, geometry: { coordinates: geo(0, 3) } }, { confidence: 0.9, geometry: { coordinates: geo(4, 8, 85) } }];
  const r2 = await H.mapMatchTrail(pts, "tok", resp(tp2, mm2));
  chk("5m junta recta de más de 60 m entre fragmentos: sus dos extremos crudos", !!r2 && r2.esCrudo[3] === true && r2.esCrudo[4] === true && r2.esCrudo.filter(Boolean).length === 2);
  const tp3 = tp2, mm3 = [{ confidence: 0.9, geometry: { coordinates: geo(0, 3) } }, { confidence: 0.9, geometry: { coordinates: geo(4, 8) } }];
  const r3 = await H.mapMatchTrail(pts, "tok", resp(tp3, mm3));
  chk("5n junta corta (18 m) entre fragmentos: nada cambia", !!r3 && r3.esCrudo.every((x) => !x));
  const cands = H.puentesCrudos(r2!.coords, H.rangosDeCrudo(r2!.esCrudo, r2!.coords.length).crudoRanges);
  chk("5o y esa junta se ofrece para rellenar por la vía", cands.length === 1 && cands[0].origen === "crudo");

  // La junta entre dos ventanas del ajustador.
  const c: [number, number][] = [[LNG, LAT], [LNG, LAT + 30 * M_LAT], [LNG, LAT + 400 * M_LAT], [LNG, LAT + 430 * M_LAT]];
  const es = [false, false, false, false];
  H.marcarJuntasRectas(c, es, [2, 2]);
  chk("5p junta de 370 m entre ventanas (antes un hueco que nadie rellenaba): extremos crudos", es.join() === "false,true,true,false");
  const es2 = [false, false, false, false];
  H.marcarJuntasRectas([[LNG, LAT], [LNG, LAT + 30 * M_LAT], [LNG, LAT + 40 * M_LAT], [LNG, LAT + 70 * M_LAT]], es2, [2, 2]);
  chk("5q junta corta entre ventanas: nada cambia", es2.every((x) => !x));
}

// ── 6. La vía pegada pasa por donde iba el bus (#17498) ────────────────────────
// Un fragmento CONFIABLE se dibujaba entero. En un intercambio, Map Matching enrutó entre dos puntos
// pegados por la vía PARALELA y dejó sin pareja los fixes de ±2 m del ramal correcto: la huella medida
// corría por donde no hubo ningún punto.
{
  const M_LNG = 1 / (111_320 * Math.cos(LAT * Math.PI / 180));
  const P = (n: number, e = 0): [number, number] => [LNG + e * M_LNG, LAT + n * M_LAT];   // n m al norte, e m al este
  type Salida = Awaited<ReturnType<typeof H.mapMatchTrail>>;
  const resp = (tp: unknown[], matchings: unknown[]) => async () => new Response(JSON.stringify({ code: "Ok", matchings, tracepoints: tp }), { status: 200 });
  const tpDe = (pares: (number | null)[], loc: (i: number) => [number, number] | undefined) =>
    pares.map((m, i) => (m == null ? null : { matchings_index: m, location: loc(i) }));
  const esta = (r: Salida, p: { lat: number; lng: number }) => !!r?.coords.some(([x, y]) => x === p.lng && y === p.lat);
  const alEste = (r: Salida, e: number) => r?.coords.filter(([x]) => Math.abs((x - LNG) / M_LNG - e) < 1).length ?? -1;
  // 9 fixes de ±2 m cada 3 s, 16 m al norte cada uno (19 km/h): el bus va por la vía A (e = 0).
  const pts = Array.from({ length: 9 }, (_, i) => ({ ...fix(i * 16, i * 3, 2), velocidad: 19 }));
  const snap = (i: number) => P(i * 16, 1);   // la vía A, a 1 m del fix

  // Mapbox pega 0-2 y 6-8 a la vía A, deja sin pareja 3-5 y entre 2 y 6 enruta por la paralela B (40 m al este).
  const geoB = [snap(0), snap(1), snap(2), P(40, 40), P(56, 40), P(72, 40), P(88, 40), snap(6), snap(7), snap(8)];
  const paresB = [0, 0, 0, null, null, null, 0, 0, 0];
  const r = await H.mapMatchTrail(pts, "tok", resp(tpDe(paresB, snap), [{ confidence: 0.9, geometry: { coordinates: geoB } }]));
  chk("6a la paralela por donde no hubo ningún punto ya no se dibuja", alEste(r, 40) === 0, `${alEste(r, 40)} vértices en B`);
  chk("6b los tres fixes de ±2 m del ramal entran a la huella", [3, 4, 5].every((i) => esta(r, pts[i])));
  chk("6c y se dibujan medidos (16 m en 3 s: siguen la calle)", !!r && r.esCrudo.every((x) => !x));
  chk("6d el resto del fragmento sigue pegado a la vía", !!r && [0, 1, 2, 6, 7, 8].every((i) => r.coords.some(([x, y]) => x === snap(i)[0] && y === snap(i)[1])));
  const viejo = await H.mapMatchTrail(pts, "tok", resp(tpDe(paresB, () => undefined), [{ confidence: 0.9, geometry: { coordinates: geoB } }]));
  chk("6e REGRESIÓN: sin la prueba (sin location) se dibujaba la paralela", alEste(viejo, 40) === 4 && ![3, 4, 5].some((i) => esta(viejo, pts[i])));
  const piezas = H.piezasDeFragmento(geoB, pts, tpDe(paresB, snap), 0);
  chk("6f el fragmento se parte en vía · fixes · vía", piezas.map((p) => ("via" in p ? "v" : "f")).join("") === "vfffv");

  // Rodeo por los ramales: entre 4 y 5 (3 s) Mapbox mete ~850 m de lazo, todos los puntos con pareja.
  const geoL = [snap(0), snap(1), snap(2), snap(3), snap(4), P(64, 200), P(300, 200), P(300, 1), snap(5), snap(6), snap(7), snap(8)];
  const todos = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rl = await H.mapMatchTrail(pts, "tok", resp(tpDe(todos, snap), [{ confidence: 0.9, geometry: { coordinates: geoL } }]));
  chk("6g un lazo de 850 m en 3 s (imposible para un bus) no se dibuja", alEste(rl, 200) === 0, `${alEste(rl, 200)} vértices del lazo`);
  chk("6h y la junta 4→5 (16 m) se dibuja medida", !!rl && rl.esCrudo.every((x) => !x) && rl.coords.length === 9);
  // El mismo lazo con 60 s entre 4 y 5 sí cabe (36 m/s × 60 s): no es imposible, no se toca.
  const lento = pts.map((p, i) => (i >= 5 ? { ...p, ts: p.ts + 57_000 } : p));
  const rlL = await H.mapMatchTrail(lento, "tok", resp(tpDe(todos, snap), [{ confidence: 0.9, geometry: { coordinates: geoL } }]));
  chk("6i el mismo lazo en 60 s es posible: se dibuja como siempre", alEste(rlL, 200) === 2);

  // Lo que está bien no cambia: una curva legítima a 5 m de los fixes sin pareja.
  const geoC = [snap(0), snap(1), snap(2), P(48, 5), P(64, 5), P(80, 5), snap(6), snap(7), snap(8)];
  const conLoc = await H.mapMatchTrail(pts, "tok", resp(tpDe(paresB, snap), [{ confidence: 0.9, geometry: { coordinates: geoC } }]));
  const sinLoc = await H.mapMatchTrail(pts, "tok", resp(tpDe(paresB, () => undefined), [{ confidence: 0.9, geometry: { coordinates: geoC } }]));
  chk("6j la vía a 5 m de los fixes sin pareja: byte a byte lo de antes", JSON.stringify(conLoc) === JSON.stringify(sinLoc));
  chk("6k …y la pieza es la geometría entera (el mismo arreglo)", (() => { const p = H.piezasDeFragmento(geoC, pts, tpDe(paresB, snap), 0); return p.length === 1 && "via" in p[0] && p[0].via === geoC; })());
  // Un fix de RED (o sin precisión) sin pareja no prueba nada: la paralela se dibuja como antes.
  for (const acc of [40, 0]) {
    const red = pts.map((p, i) => (i >= 3 && i <= 5 ? { ...p, acc } : p));
    const rr = await H.mapMatchTrail(red, "tok", resp(tpDe(paresB, snap), [{ confidence: 0.9, geometry: { coordinates: geoB } }]));
    chk(`6l fix sin pareja de ±${acc} m: no se juzga`, alEste(rr, 40) === 4);
  }
  // Una location que no es un vértice de la geometría: no se puede juzgar, el fragmento entero.
  const fuera = await H.mapMatchTrail(pts, "tok", resp(tpDe(paresB, (i) => P(i * 16, 30)), [{ confidence: 0.9, geometry: { coordinates: geoB } }]));
  chk("6m location que no está en la geometría: el fragmento entero, como antes", alEste(fuera, 40) === 4);

  // Un fix de RED anclado conserva su hora y se dibuja en la cuerda de sus confiables (anclarImprecisos),
  // a veces junto al anterior. Datos reales de #17498 en la Panamericana a 89 km/h: 17:21:08 (±1.5),
  // 17:21:12 (±77, anclado 16 m después del anterior) y 17:21:14 (±1.5, 145 m después). Medido contra
  // la hora del de red, el bus «recorría» 129 m en 2 s y la carretera salía como estimado.
  const ruta = [
    { ...fix(-99, -4, 1.5), velocidad: 89 }, { ...fix(0, 0, 1.5), velocidad: 89 },
    { ...fix(16, 4, 77), velocidad: 0 }, { ...fix(145, 6, 1.5), velocidad: 89 }, { ...fix(243, 10, 1.5), velocidad: 89 },
  ];
  const snapR = (i: number) => P((ruta[i].lat - LAT) / M_LAT, 1);
  const geoR = ruta.map((_, i) => snapR(i));
  const rr = await H.mapMatchTrail(ruta, "tok", resp(tpDe([0, 0, 0, 0, 0], snapR), [{ confidence: 0.9, geometry: { coordinates: geoR } }]));
  chk("6r un fix de red anclado no parte la carretera: se dibuja entera y medida",
    !!rr && rr.coords.length === 5 && rr.esCrudo.every((x) => !x), JSON.stringify(rr?.esCrudo));
  chk("6s …la pieza es la geometría entera", (() => { const p = H.piezasDeFragmento(geoR, ruta, tpDe([0, 0, 0, 0, 0], snapR), 0); return p.length === 1 && "via" in p[0] && p[0].via === geoR; })());
  // Pero un lazo imposible cuyo extremo es ese fix de red se sigue viendo, medido entre los precisos.
  const geoRL = [snapR(0), snapR(1), snapR(2), P(40, 400), P(145, 400), snapR(3), snapR(4)];
  const rrl = await H.mapMatchTrail(ruta, "tok", resp(tpDe([0, 0, 0, 0, 0], snapR), [{ confidence: 0.9, geometry: { coordinates: geoRL } }]));
  chk("6t …y un lazo de 900 m junto a él sigue sin dibujarse", alEste(rrl, 400) === 0, `${alEste(rrl, 400)} vértices del lazo`);

  // Barrido: fragmentos con y sin rodeos, nulls al azar, precisiones mezcladas.
  let semilla = 7;
  const rnd = () => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const radio = (acc: number) => Math.max(H.TOL_VIA_M, H.radioDeBusqueda(acc));
  let casos = 0, violaciones = 0, violacionesAntes = 0, cambiosSinRodeo = 0, guardias = 0;
  for (let c = 0; c < 600; c++) {
    const n = 8 + Math.floor(rnd() * 12), paso = 8 + rnd() * 50, dt = 2 + rnd() * 12;
    const accs = [2, 5, 12, 20, 40, 0];
    const fx = Array.from({ length: n }, (_, i) => ({ lat: LAT + i * paso * M_LAT, lng: LNG, acc: accs[Math.floor(rnd() * accs.length)], ts: T0 + i * dt * 1000 }));
    const corte = rnd() < 0.4 ? 2 + Math.floor(rnd() * (n - 4)) : n;   // 1 o 2 fragmentos contiguos
    const fragDe: number[] = fx.map((_, i) => (i < corte ? 0 : 1));
    const pares = fx.map((_, i) => { const ini = i === 0 || i === corte, fin = i === n - 1 || i === corte - 1; return !ini && !fin && rnd() < 0.3 ? null : fragDe[i]; });
    const off = fx.map(() => rnd() * 8);
    const loc = (i: number) => P(i * paso, off[i]);
    let conRodeo = false;
    const matchings = [0, 1].filter((f) => fragDe.includes(f)).map((f) => {
      const g: [number, number][] = [];
      let prev = -1;
      for (let i = 0; i < n; i++) {
        if (fragDe[i] !== f || pares[i] == null) continue;
        if (prev >= 0) {
          const r0 = rnd();
          if (r0 < 0.15) { conRodeo = true; for (let j = prev + 1; j < i; j++) g.push(P(j * paso, 30 + rnd() * 60)); if (i === prev + 1) g.push(P((prev + 0.5) * paso, 60)); }
          else if (r0 < 0.25) { conRodeo = true; g.push(P(prev * paso, 400), P(i * paso + 300, 400), P(i * paso + 300, 0)); }
          else for (let j = prev + 1; j < i; j++) g.push(P(j * paso, rnd() * 8));
        }
        g.push(loc(i));
        prev = i;
      }
      return { confidence: 0.9, geometry: { coordinates: g } };
    });
    const tp = tpDe(pares, loc);
    const out = await H.mapMatchTrail(fx, "tok", resp(tp, matchings));
    const antes = await H.mapMatchTrail(fx, "tok", resp(tpDe(pares, () => undefined), matchings));
    if (!out) continue;
    casos++;
    const igual = JSON.stringify(out) === JSON.stringify(antes);
    if (!igual) guardias++;
    if (!igual && !conRodeo) cambiosSinRodeo++;
    // Invariante: todo fix PRECISO dentro del tramo de un fragmento queda a su tolerancia de la huella.
    const dist = (p: { lat: number; lng: number }, lin: [number, number][] = out.coords) => {
      let b = Infinity;
      for (let j = 0; j + 1 < lin.length; j++) {
        const ax = (lin[j][0] - p.lng) / M_LNG, ay = (lin[j][1] - p.lat) / M_LAT, bx = (lin[j + 1][0] - p.lng) / M_LNG, by = (lin[j + 1][1] - p.lat) / M_LAT;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        b = Math.min(b, Math.hypot(ax + t * dx, ay + t * dy));
      }
      return b;
    };
    for (let i = 0; i < n; i++) {
      if (!(fx[i].acc > 0 && fx[i].acc <= 20)) continue;
      if (dist(fx[i]) > radio(fx[i].acc) + 0.5) violaciones++;
      if (antes && dist(fx[i], antes.coords) > radio(fx[i].acc) + 0.5) violacionesAntes++;
    }
  }
  chk("6n barrido: todo fix preciso queda a su tolerancia de la huella", violaciones === 0, `${violaciones} en ${casos} casos`);
  chk("6o barrido: sin rodeo inyectado, byte a byte lo de antes", cambiosSinRodeo === 0, `${cambiosSinRodeo}`);
  chk("6p corolario: la prueba sí actúa", guardias > 50, `${guardias} de ${casos}`);
  chk("6q …y sin ella el barrido sí encuentra fixes precisos lejos de la huella", violacionesAntes > 50, `${violacionesAntes}`);
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
