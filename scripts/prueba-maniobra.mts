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

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
