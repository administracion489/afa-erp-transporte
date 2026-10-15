// Matriz de la MARCACIÓN de RRHH: geocerca (validarMarca) y siguiente hito (tipoSiguiente).
// Uso:  npx tsx scripts/prueba-marcacion.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · GEOCERCA SIMÉTRICA. Un punto al norte y otro al sur a la misma distancia dan la
//     misma `distancia_m` y el mismo veredicto: el haversine no privilegia un rumbo. El
//     borde es INCLUSIVO (exactamente en el radio = dentro) y se prueba con el radio
//     puesto a la distancia cruda. Coordenada no utilizable (punto o sede) → Infinity,
//     fuera: "no sé dónde estás" nunca es "estás dentro".
//
// 2 · tipoSiguiente POR BARRIDO sobre los 16 subconjuntos de hitos, con el orden de
//     entrada barajado y con duplicados: la respuesta depende del CONJUNTO, no del orden
//     de llegada.
//
// 3 · INVARIANTE DURA: tipoSiguiente jamás propone un tipo cuyo predecesor en el orden
//     falte (jamás "salida" antes de "entrada"). Y el CORolario anti-trivial: sí propone
//     un hito cuando corresponde (un motor que devolviera siempre null cumpliría lo de
//     arriba de forma trivial).
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const M = requerir("../lib/rrhh/marcacion") as typeof import("../lib/rrhh/marcacion");
const H = requerir("../lib/huella") as typeof import("../lib/huella");
const { validarMarca, tipoSiguiente, ORDEN_MARCAS, esTipoMarca } = M;
const { distM } = H;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const SEDE = { sede_lat: -12.05, sede_lng: -77.04 } as any;
const cfg = (radio: number, extra: any = {}) => ({
  ...SEDE, sede_radio_m: radio,
  hora_entrada: "08:00", hora_salida: "17:00", tolerancia_min: 10, almuerzo_min: 60,
  geocerca_bloquea: true, ...extra,
});

// ── 1 · GEOCERCA ──────────────────────────────────────────────────────────────
console.log("\n1 · Geocerca: simétrica, borde inclusivo, coordenada inválida\n");

// 1° de latitud ≈ 111 320 m. Un offset chico para quedar cerca de la sede.
const dLat100 = 100 / 111_320; // ≈ 100 m hacia el norte/sur

const norte = { lat: SEDE.sede_lat + dLat100, lng: SEDE.sede_lng };
const sur = { lat: SEDE.sede_lat - dLat100, lng: SEDE.sede_lng };
const este = { lat: SEDE.sede_lat, lng: SEDE.sede_lng + dLat100 };
const oeste = { lat: SEDE.sede_lat, lng: SEDE.sede_lng - dLat100 };

const dN = validarMarca(norte, cfg(150));
const dS = validarMarca(sur, cfg(150));
const dE = validarMarca(este, cfg(150));
const dO = validarMarca(oeste, cfg(150));

chk("norte y sur a la misma distancia dan la misma distancia_m",
  dN.distancia_m === dS.distancia_m, `${dN.distancia_m} vs ${dS.distancia_m}`);
chk("este y oeste a la misma distancia dan la misma distancia_m",
  dE.distancia_m === dO.distancia_m, `${dE.distancia_m} vs ${dO.distancia_m}`);
chk("los cuatro rumbos a ~100 m están dentro de un radio de 150 m",
  dN.dentro_geocerca && dS.dentro_geocerca && dE.dentro_geocerca && dO.dentro_geocerca,
  `${dN.distancia_m} m`);
chk("…y fuera de un radio de 50 m",
  !validarMarca(norte, cfg(50)).dentro_geocerca && !validarMarca(este, cfg(50)).dentro_geocerca);

// El centro exacto: distancia 0, dentro de cualquier radio positivo.
const centro = validarMarca({ lat: SEDE.sede_lat, lng: SEDE.sede_lng }, cfg(10));
chk("en la sede misma: distancia 0 y dentro", centro.distancia_m === 0 && centro.dentro_geocerca);

// Borde INCLUSIVO: con el radio puesto exactamente a la distancia cruda, está dentro.
const rawN = distM(SEDE.sede_lat, SEDE.sede_lng, norte.lat, norte.lng);
chk("borde inclusivo: radio = distancia exacta ⇒ dentro",
  validarMarca(norte, cfg(rawN)).dentro_geocerca === true);
chk("un pelo menos de radio ⇒ fuera",
  validarMarca(norte, cfg(rawN - 0.001)).dentro_geocerca === false);

// Consistencia dentro ⇔ distM ≤ radio, por barrido de offsets.
let incoherente = 0;
for (let k = 1; k <= 60; k++) {
  const p = { lat: SEDE.sede_lat + (dLat100 / 100) * k, lng: SEDE.sede_lng };
  const raw = distM(SEDE.sede_lat, SEDE.sede_lng, p.lat, p.lng);
  const r = validarMarca(p, cfg(200));
  if (r.dentro_geocerca !== raw <= 200) incoherente++;
}
chk("dentro_geocerca ⇔ (distM ≤ radio) en 60 offsets", incoherente === 0, `${incoherente} incoherencias`);

// Coordenada no utilizable: Infinity y fuera. NUNCA dentro por falta de dato.
chk("punto sin lat ⇒ Infinity, fuera",
  validarMarca({ lat: null, lng: SEDE.sede_lng } as any, cfg(10000)).distancia_m === Infinity &&
  validarMarca({ lat: null, lng: SEDE.sede_lng } as any, cfg(10000)).dentro_geocerca === false);
chk("punto (0,0) ⇒ Infinity, fuera (es 'sin dato', no una posición)",
  validarMarca({ lat: 0, lng: 0 }, cfg(10000)).distancia_m === Infinity &&
  validarMarca({ lat: 0, lng: 0 }, cfg(10000)).dentro_geocerca === false);
chk("sede (0,0) ⇒ Infinity, fuera",
  validarMarca(norte, cfg(10000, { sede_lat: 0, sede_lng: 0 })).dentro_geocerca === false);
chk("radio 0 ⇒ solo la distancia exacta 0 cuenta como dentro",
  validarMarca({ lat: SEDE.sede_lat, lng: SEDE.sede_lng }, cfg(0)).dentro_geocerca === true &&
  validarMarca(norte, cfg(0)).dentro_geocerca === false);

// ── 2 y 3 · tipoSiguiente ─────────────────────────────────────────────────────
console.log("\n2 · tipoSiguiente: barrido de los 16 subconjuntos (orden barajado + duplicados)\n");

const ORDEN = [...ORDEN_MARCAS];
const idx = (t: string) => ORDEN.indexOf(t as any);

// Referencia independiente del motor: null si 'salida' está; si no, el primer faltante.
function esperado(presentes: Set<string>): string | null {
  if (presentes.has("salida")) return null;
  for (const t of ORDEN) if (!presentes.has(t)) return t;
  return null;
}

const barajar = <T,>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
};

let combinaciones = 0;
let violaOrden = 0;
let difEsperado = 0;
let propuestoYaPresente = 0;
let ordenImporta = 0;
let hayPropuesta = 0;

for (let mask = 0; mask < 16; mask++) {
  const presentes = new Set<string>();
  ORDEN.forEach((t, i) => { if (mask & (1 << i)) presentes.add(t); });

  // Marcas en orden barajado y con un duplicado, para probar que da igual el orden.
  const base = [...presentes].map((t) => ({ tipo: t }));
  const marcas = barajar([...base, ...(base.length ? [base[0]] : [])]);

  const r = tipoSiguiente(marcas);
  combinaciones++;

  // (a) coincide con la referencia
  if (r !== esperado(presentes)) difEsperado++;

  // (b) INVARIANTE: si propone algo, todos sus predecesores están presentes
  if (r != null) {
    hayPropuesta++;
    if (!esTipoMarca(r)) violaOrden++;
    else {
      for (let i = 0; i < idx(r); i++) if (!presentes.has(ORDEN[i])) violaOrden++;
      if (presentes.has(r)) propuestoYaPresente++; // nunca propone algo ya hecho
    }
  }

  // (c) el orden de llegada no cambia la respuesta
  const r2 = tipoSiguiente(barajar(marcas));
  if (r2 !== r) ordenImporta++;
}

chk(`${combinaciones} subconjuntos · coincide con la referencia`, difEsperado === 0, `${difEsperado} dif.`);
chk(`${combinaciones} subconjuntos · INVARIANTE: nunca viola el orden`, violaOrden === 0, `${violaOrden} violaciones`);
chk(`${combinaciones} subconjuntos · nunca propone un hito ya hecho`, propuestoYaPresente === 0);
chk(`${combinaciones} subconjuntos · la respuesta no depende del orden de llegada`, ordenImporta === 0);
// Corolario anti-trivial: hay casos donde SÍ propone (si no, todo lo de arriba sería trivial).
chk("no es trivial: hay subconjuntos donde propone un hito", hayPropuesta > 0, `${hayPropuesta} con propuesta`);

// La cadena del camino feliz, explícita.
console.log("\n3 · El camino feliz, paso a paso\n");
const m = (t: string) => ({ tipo: t });
chk("día vacío ⇒ entrada", tipoSiguiente([]) === "entrada");
chk("[entrada] ⇒ salida_almuerzo", tipoSiguiente([m("entrada")]) === "salida_almuerzo");
chk("[entrada, salida_almuerzo] ⇒ regreso_almuerzo",
  tipoSiguiente([m("entrada"), m("salida_almuerzo")]) === "regreso_almuerzo");
chk("[entrada, salida_almuerzo, regreso_almuerzo] ⇒ salida",
  tipoSiguiente([m("entrada"), m("salida_almuerzo"), m("regreso_almuerzo")]) === "salida");
chk("día completo ⇒ null",
  tipoSiguiente([m("entrada"), m("salida_almuerzo"), m("regreso_almuerzo"), m("salida")]) === null);
chk("salida presente (sin almuerzo) ⇒ null: salida es terminal",
  tipoSiguiente([m("entrada"), m("salida")]) === null);
chk("datos corruptos (solo salida) ⇒ null, no se ofrece nada",
  tipoSiguiente([m("salida")]) === null);
chk("marcas con tipos basura se ignoran",
  tipoSiguiente([{ tipo: "cafe" }, m("entrada")]) === "salida_almuerzo");

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
