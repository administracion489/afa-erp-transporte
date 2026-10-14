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

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
