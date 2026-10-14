// scripts/diagnostico-huella-texto.mts — SOLO LEE un archivo de texto. Reproduce la huella del modal
// GPS con las posiciones que devuelve supabase/diagnostico-huella-reserva.sql (la celda copiada).
// Correr: npx tsx scripts/diagnostico-huella-texto.mts <archivo.txt>
//
// Sin red: no llama a Map Matching. Lo que sí dice, con la MISMA tubería del modal (lib/huella.ts):
//   1. las primeras posiciones crudas: cada cuánto llegan, cuánto saltan, a qué velocidad real
//      (distancia ÷ tiempo) contra la que reporta el equipo, y su precisión;
//   2. la huella limpia (huellaDeFilas): dónde quedó la parada inicial y el color de cada punto;
//   3. las cuerdas que la huella dibujaría rectas (más de MAX_SEG_CRUDO_M) y si son maniobra o marcha;
//   4. lo que dibuja la ventana cuando Map Matching NO pega (el respaldo crudo suavizado).

import { readFileSync } from "node:fs";
import * as H from "../lib/huella";

const archivo = process.argv[2];
if (!archivo) { console.error("Uso: npx tsx scripts/diagnostico-huella-texto.mts <archivo.txt>"); process.exit(1); }
const texto = readFileSync(archivo, "utf8");

const fecha = texto.match(/fecha (\d{4}-\d{2}-\d{2})/)?.[1];
if (!fecha) { console.error("No encuentro la línea «#RESERVA … · fecha AAAA-MM-DD»."); process.exit(1); }
const seccion = (nombre: string) => {
  const ini = texto.indexOf(`#${nombre}`);
  if (ini < 0) return [] as string[];
  const resto = texto.slice(ini).split("\n").slice(1);
  const fin = resto.findIndex((l) => l.startsWith("#"));
  return (fin < 0 ? resto : resto.slice(0, fin)).map((l) => l.trim()).filter(Boolean);
};

// Lima es UTC-5 sin horario de verano: la hora local + 5 h es la UTC.
const aIso = (hhmmss: string) => new Date(`${fecha}T${hhmmss}-05:00`).toISOString();
const filas = seccion("GPS").map((l, i) => {
  const [hora, lat, lng, prec, vel, rumbo, estado, simulado] = l.split(",");
  return {
    id: i + 1, created_at: aIso(hora), lat: lat === "" ? null : Number(lat), lng: lng === "" ? null : Number(lng),
    precision_m: prec === "" ? null : Number(prec), velocidad: vel === "" ? 0 : Number(vel),
    rumbo: rumbo === "" ? 0 : Number(rumbo), estado, simulado: simulado === "true",
  };
});
const paraderos = seccion("PARADEROS").map((l) => {
  const [orden, lat, lng, estado, horaEst, horaLleg, ...nombre] = l.split(",");
  return { orden: Number(orden), lat: Number(lat), lng: Number(lng), estado, horaEst, horaLleg, nombre: nombre.join(",") };
});
const hhmmss = (ts: number) => new Date(ts - 5 * 3600_000).toISOString().slice(11, 19);
const m = (x: number) => `${Math.round(x)} m`;
console.log(`${filas.length} posiciones · ${paraderos.length} paraderos · ${fecha}\n`);

// ── 1. Las crudas del inicio ──────────────────────────────────────────────────
const { brutos, crudos, limpio } = H.huellaDeFilas(filas.filter((f) => !f.simulado));
console.log("1 · PRIMERAS 40 POSICIONES CRUDAS (hora · salto · s · km/h real · km/h equipo · precisión)");
for (let i = 0; i < Math.min(40, brutos.length); i++) {
  const p = brutos[i], q = brutos[i - 1];
  const d = q ? H.distM(q.lat, q.lng, p.lat, p.lng) : 0;
  const dt = q ? (p.ts - q.ts) / 1000 : 0;
  const real = dt > 0 ? (d / dt) * 3.6 : 0;
  const marca = q && d > H.MAX_SEG_CRUDO_M ? (real > H.VEL_MANIOBRA_KMH ? "  ← salto en marcha" : "  ← salto lento") : "";
  console.log(`  ${hhmmss(p.ts)}  ${m(d).padStart(6)}  ${String(Math.round(dt)).padStart(4)}s  ${String(Math.round(real)).padStart(4)}  ${String(p.velocidad).padStart(4)}  ±${p.acc}${marca}`);
}

// ── 2. La huella limpia ───────────────────────────────────────────────────────
console.log(`\n2 · HUELLA LIMPIA: ${brutos.length} crudas → ${crudos.length} ancladas → ${limpio.length} limpias`);
const color = (v: number) => (v >= 55 ? "Rápido" : v >= 35 ? "Moderado" : v >= 15 ? "Lento" : "Parado");
for (let i = 0; i < Math.min(25, limpio.length); i++) {
  const p = limpio[i], q = limpio[i - 1];
  const d = q ? H.distM(q.lat, q.lng, p.lat, p.lng) : 0;
  const cerca = paraderos.length ? paraderos.reduce((b, s) => {
    const ds = H.distM(p.lat, p.lng, s.lat, s.lng); return ds < b.d ? { d: ds, s } : b;
  }, { d: Infinity, s: paraderos[0] }) : null;
  console.log(`  ${hhmmss(p.ts)}  ${p.lat.toFixed(6)},${p.lng.toFixed(6)}  ${m(d).padStart(6)}  ${String(p.velocidad).padStart(3)} km/h ${color(p.velocidad).padEnd(8)} ±${p.acc}`
    + (cerca && cerca.d < 150 ? `  junto a paradero ${cerca.s.orden} (${m(cerca.d)})` : ""));
}

// ── 3. Cuerdas largas ─────────────────────────────────────────────────────────
console.log(`\n3 · CUERDAS DE MÁS DE ${H.MAX_SEG_CRUDO_M} m EN LA HUELLA LIMPIA (las que se ven rectas)`);
let largas = 0;
for (let i = 1; i < limpio.length; i++) {
  const p = limpio[i], q = limpio[i - 1];
  const d = H.distM(q.lat, q.lng, p.lat, p.lng);
  if (d <= H.MAX_SEG_CRUDO_M) continue;
  largas++;
  const dt = (p.ts - q.ts) / 1000, kmh = dt > 0 ? (d / dt) * 3.6 : NaN;
  if (largas <= 30) console.log(`  ${hhmmss(q.ts)} → ${hhmmss(p.ts)}  ${m(d)} en ${Math.round(dt)} s (${Math.round(kmh)} km/h) · ±${q.acc}/±${p.acc}`
    + (kmh > H.VEL_MANIOBRA_KMH ? " · en marcha: se rellena por la vía" : " · lenta: maniobra"));
}
console.log(`  total: ${largas}`);

// ── 4. Si Map Matching no pega la primera ventana ─────────────────────────────
const sinMatch = async () => new Response(JSON.stringify({ code: "NoMatch" }), { status: 422 });
const ventana = limpio.slice(0, 100);
if (ventana.length >= 2) {
  const r = await H.matchVentana(ventana, "tok", sinMatch);
  const crudosV = r.esCrudo.filter(Boolean).length;
  const segs = H.colorearMatched(r.coords, ventana as any, [], r.esCrudo) as any[];
  const largos = segs.filter((f) => { const [[a, b], [c, d]] = f.geometry.coordinates; return H.distM(b, a, d, c) > H.MAX_SEG_CRUDO_M; });
  console.log(`\n4 · PRIMERA VENTANA SIN AJUSTE A LA VÍA: ${r.coords.length} vértices, ${crudosV} crudos (se rellenarían por la vía), ${segs.length} segmentos dibujados, ${largos.length} de más de ${H.MAX_SEG_CRUDO_M} m`);
}
