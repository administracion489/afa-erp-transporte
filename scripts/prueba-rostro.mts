// Matriz de la VERIFICACIÓN FACIAL 1:1 de RRHH (lib/rrhh/rostro.ts).
// Uso:  npx tsx scripts/prueba-rostro.mts   (sale con código 1 si algo falla)
//
// Es todo NET-NEW: no hay "algoritmo viejo copiado literal" contra el cual comparar,
// porque este motor no reemplaza a ninguno. Lo que se fija son sus INVARIANTES y el
// COROLARIO anti-trivial, de modo que un motor degenerado —el que siempre dijera
// "coincide", o siempre "enrolar"— falle la matriz.
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · `distancia` SIMÉTRICA y `distancia(a,a) === 0` por barrido: el euclídeo no
//     privilegia un orden, y un vector contra sí mismo dista 0. Un descriptor no
//     utilizable (longitud ≠ 128, NaN/Infinity, no-array) → Infinity, nunca 0: "no
//     puedo comparar" jamás es "son iguales".
//
// 2 · `coincide ⟺ distancia <= UMBRAL`, con la distancia que `coincide` devuelve (no
//     una recalculada), y comprobado en el BORDE EXACTO: umbral = distancia real ⇒
//     coincide (inclusivo); un pelo menos ⇒ no coincide. Barrido con casos a ambos
//     lados del umbral (corolario: existen los dos, si no el biconditional sería trivial).
//
// 3 · CICLO `deserializar(serializar(d)) ≈ d` (escribir y leer bajo la MISMA identidad):
//     la referencia que se guarda es la que se lee. Y es IDEMPOTENTE: re-serializar lo
//     leído da el MISMO texto. `serializar` rechaza longitudes ≠ 128 y NaN/Infinity, y
//     acepta el Float32Array que entrega face-api.
//
// 4 · `decidirRostro`: candidato inválido manda sobre todo (rechazar); sin referencia y
//     candidato bueno ⇒ enrolar; ambos buenos ⇒ verificar/coincide o rechazar/no_coincide
//     con su distancia. COROLARIO anti-trivial: ref === cand ⇒ coincide (un motor que
//     siempre enrolara fallaría); ref muy lejana ⇒ no_coincide (uno que siempre dijera
//     "coincide" fallaría). Se comprueba además que aparecen los CUATRO códigos.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const R = requerir("../lib/rrhh/rostro") as typeof import("../lib/rrhh/rostro");
const {
  UMBRAL_DISTANCIA, DIM_DESCRIPTOR,
  esDescriptorValido, distancia, coincide,
  serializarDescriptor, deserializarDescriptor, decidirRostro,
} = R;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// PRNG determinista (mulberry32): la matriz no depende de la suerte.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Un descriptor realista: 128 valores con muchos decimales (para que el redondeo de
// `serializar` de verdad recorte algo), en el rango ~[-1, 1) de face-api.
const vec = (rnd: () => number): number[] =>
  Array.from({ length: DIM_DESCRIPTOR }, () => rnd() * 2 - 1);

chk("UMBRAL_DISTANCIA = 0.55 (declarado)", UMBRAL_DISTANCIA === 0.55, `${UMBRAL_DISTANCIA}`);
chk("DIM_DESCRIPTOR = 128", DIM_DESCRIPTOR === 128, `${DIM_DESCRIPTOR}`);

// ── 1 · distancia: simétrica, cero consigo misma, inválido → Infinity ───────────
console.log("\n1 · distancia: simétrica, distancia(a,a)=0, inválido ⇒ Infinity\n");

const rnd1 = prng(1);
let asimetrico = 0, noCero = 0;
for (let k = 0; k < 500; k++) {
  const a = vec(rnd1), b = vec(rnd1);
  if (distancia(a, b) !== distancia(b, a)) asimetrico++;
  if (distancia(a, a) !== 0) noCero++;
}
chk("distancia(a,b) === distancia(b,a) en 500 pares", asimetrico === 0, `${asimetrico} asimétricos`);
chk("distancia(a,a) === 0 en 500 vectores", noCero === 0, `${noCero} ≠ 0`);

const base = vec(prng(7));
const corta = base.slice(0, 127);
const larga = [...base, 0];
const conNaN = [...base]; conNaN[10] = NaN;
const conInf = [...base]; conInf[20] = Infinity;
chk("longitud 127 ⇒ Infinity", distancia(base, corta as any) === Infinity);
chk("longitud 129 ⇒ Infinity", distancia(base, larga) === Infinity);
chk("un NaN dentro ⇒ Infinity", distancia(base, conNaN) === Infinity);
chk("un Infinity dentro ⇒ Infinity", distancia(base, conInf) === Infinity);
chk("no-array ⇒ Infinity (nunca lanza)", distancia(null as any, base) === Infinity && distancia(base, "x" as any) === Infinity);
chk("esDescriptorValido: 128 finitos sí, resto no",
  esDescriptorValido(base) && !esDescriptorValido(corta) && !esDescriptorValido(conNaN) && !esDescriptorValido(null));

// ── 2 · coincide ⟺ distancia <= UMBRAL, borde exacto ────────────────────────────
console.log("\n2 · coincide ⟺ distancia <= UMBRAL, borde INCLUSIVO exacto\n");

// Borde EXACTO: se toma la distancia REAL de un par y se usa de umbral.
const a2 = vec(prng(42));
const b2 = [...a2]; b2[3] += 0.4; b2[50] -= 0.3; // distancia ≈ sqrt(0.16+0.09)
const dExacta = distancia(a2, b2);
chk("umbral = distancia exacta ⇒ coincide (inclusivo)", coincide(a2, b2, dExacta).coincide === true, `d=${dExacta}`);
chk("un pelo menos de umbral ⇒ no coincide", coincide(a2, b2, dExacta - 1e-9).coincide === false);
chk("coincide devuelve la MISMA distancia que distancia()", coincide(a2, b2, dExacta).distancia === dExacta);

// Biconditional por barrido, con casos a ambos lados del umbral por defecto.
const rnd2 = prng(99);
let rompeBicond = 0, siCoincide = 0, noCoincide = 0;
for (let k = 0; k < 600; k++) {
  const a = vec(rnd2);
  const b = [...a];
  // Desplazo una componente en un rango que cruza el umbral (0..~1.1).
  b[k % DIM_DESCRIPTOR] += (k / 600) * 1.1;
  const r = coincide(a, b);
  const d = distancia(a, b);
  if (r.distancia !== d) rompeBicond++;
  if (r.coincide !== d <= UMBRAL_DISTANCIA) rompeBicond++;
  if (r.coincide) siCoincide++; else noCoincide++;
}
chk("coincide ⟺ (distancia ≤ UMBRAL) en 600 pares", rompeBicond === 0, `${rompeBicond} incoherencias`);
chk("no es trivial: hay pares que coinciden Y pares que no", siCoincide > 0 && noCoincide > 0, `${siCoincide} sí / ${noCoincide} no`);
chk("descriptor inválido nunca coincide (Infinity > umbral)", coincide(base, conNaN).coincide === false);

// ── 3 · serializar / deserializar: ciclo, idempotencia, rechazos ────────────────
console.log("\n3 · serializar/deserializar: ciclo ≈ d, idempotente, rechazos\n");

const rnd3 = prng(2026);
let cicloMal = 0, noIdempotente = 0;
for (let k = 0; k < 300; k++) {
  const d = vec(rnd3);
  const s = serializarDescriptor(d);
  if (s == null) { cicloMal++; continue; }
  const out = deserializarDescriptor(s);
  if (out == null || out.length !== DIM_DESCRIPTOR) { cicloMal++; continue; }
  // ≈ d: el único cambio permitido es el redondeo a 6 decimales (≤ 5e-7).
  for (let i = 0; i < DIM_DESCRIPTOR; i++) if (Math.abs(out[i] - d[i]) > 5e-7) cicloMal++;
  // Idempotente: re-serializar lo leído da EXACTAMENTE el mismo texto (misma identidad).
  if (serializarDescriptor(out) !== s) noIdempotente++;
}
chk("deserializar(serializar(d)) ≈ d en 300 descriptores", cicloMal === 0, `${cicloMal} fuera de tolerancia`);
chk("serializar(deserializar(serializar(d))) === serializar(d)", noIdempotente === 0, `${noIdempotente} no idempotentes`);

chk("serializar rechaza longitud 127 ⇒ null", serializarDescriptor(base.slice(0, 127)) === null);
chk("serializar rechaza longitud 129 ⇒ null", serializarDescriptor([...base, 0]) === null);
chk("serializar rechaza NaN ⇒ null", serializarDescriptor(conNaN) === null);
chk("serializar rechaza Infinity ⇒ null", serializarDescriptor(conInf) === null);
chk("serializar rechaza -Infinity ⇒ null", serializarDescriptor((() => { const c = [...base]; c[0] = -Infinity; return c; })()) === null);
chk("serializar(null) y serializar(undefined) ⇒ null", serializarDescriptor(null) === null && serializarDescriptor(undefined) === null);

// Float32Array (lo que entrega face-api) se acepta y vuelve a 128 finitos.
const f32 = Float32Array.from(base);
const sF32 = serializarDescriptor(f32);
const outF32 = sF32 ? deserializarDescriptor(sF32) : null;
chk("serializar acepta Float32Array de 128 ⇒ string", typeof sF32 === "string");
chk("…y deserializa a 128 finitos", !!outF32 && outF32.length === DIM_DESCRIPTOR && esDescriptorValido(outF32));
chk("serializar rechaza Float32Array de otra longitud", serializarDescriptor(Float32Array.from(base.slice(0, 64))) === null);

chk("deserializar de texto no-JSON ⇒ null", deserializarDescriptor("no es json {") === null);
chk("deserializar de array corto ⇒ null", deserializarDescriptor("[1,2,3]") === null);
chk("deserializar con un null adentro ⇒ null",
  deserializarDescriptor(JSON.stringify([...base.slice(0, 127), null])) === null);
chk("deserializar con un string adentro ⇒ null",
  deserializarDescriptor(JSON.stringify([...base.slice(0, 127), "x"])) === null);
chk("deserializar(null) y deserializar(undefined) ⇒ null",
  deserializarDescriptor(null) === null && deserializarDescriptor(undefined) === null);

// ── 4 · decidirRostro ───────────────────────────────────────────────────────────
console.log("\n4 · decidirRostro: enrolar / verificar / rechazar\n");

const ref = vec(prng(555));
const candInvalido = [...ref]; candInvalido[0] = NaN;
const mismo = [...ref];
const cercano = [...ref]; cercano[0] += 0.01; // dentro del umbral
const lejano = ref.map((v) => v + 1); // sqrt(128) ≈ 11.3, muy por encima de 0.55

chk("sin referencia + candidato válido ⇒ enrolar/sin_referencia", (() => {
  const r = decidirRostro(null, ref);
  return r.accion === "enrolar" && r.codigo === "sin_referencia";
})());
chk("referencia inválida + candidato válido ⇒ enrolar (referencia corrupta = no hay)", (() => {
  const r = decidirRostro(candInvalido, ref);
  return r.accion === "enrolar" && r.codigo === "sin_referencia";
})());
chk("candidato inválido ⇒ rechazar/descriptor_invalido", (() => {
  const r = decidirRostro(ref, candInvalido);
  return r.accion === "rechazar" && r.codigo === "descriptor_invalido";
})());
chk("candidato inválido MANDA sobre 'sin referencia' (null, inválido)", (() => {
  const r = decidirRostro(null, candInvalido);
  return r.accion === "rechazar" && r.codigo === "descriptor_invalido";
})());
chk("candidato null ⇒ rechazar/descriptor_invalido", decidirRostro(ref, null).codigo === "descriptor_invalido");

// COROLARIO anti-trivial 1: ref === cand ⇒ coincide (un motor "siempre enrolar" falla).
chk("ref === cand ⇒ verificar/coincide, distancia 0", (() => {
  const r = decidirRostro(ref, mismo);
  return r.accion === "verificar" && r.codigo === "coincide" && r.coincide === true && r.distancia === 0;
})());
chk("candidato cercano (dentro del umbral) ⇒ verificar/coincide", (() => {
  const r = decidirRostro(ref, cercano);
  return r.accion === "verificar" && r.codigo === "coincide" && r.coincide === true;
})());
// COROLARIO anti-trivial 2: ref muy lejana ⇒ no_coincide (un motor "siempre coincide" falla).
chk("ref muy lejana ⇒ rechazar/no_coincide, con distancia > UMBRAL", (() => {
  const r = decidirRostro(ref, lejano);
  return r.accion === "rechazar" && r.codigo === "no_coincide" && r.coincide === false &&
    typeof r.distancia === "number" && r.distancia > UMBRAL_DISTANCIA;
})());

// Barrido: la acción de decidirRostro concuerda con coincide, y aparecen los 4 códigos.
const rnd4 = prng(314);
const vistos = new Set<string>();
let desacuerdo = 0;
// descriptor_invalido
vistos.add(decidirRostro(ref, null).codigo);
vistos.add(decidirRostro(null, ref).codigo); // sin_referencia
for (let k = 0; k < 400; k++) {
  const a = vec(rnd4);
  const b = [...a];
  b[k % DIM_DESCRIPTOR] += (k / 400) * 1.1; // cruza el umbral
  const r = decidirRostro(a, b);
  vistos.add(r.codigo);
  const esperado = coincide(a, b).coincide;
  const ok = esperado
    ? r.accion === "verificar" && r.codigo === "coincide"
    : r.accion === "rechazar" && r.codigo === "no_coincide";
  if (!ok) desacuerdo++;
}
chk("decidirRostro concuerda con coincide en 400 pares válidos", desacuerdo === 0, `${desacuerdo} desacuerdos`);
chk("aparecen los CUATRO códigos (no es trivial)",
  ["sin_referencia", "coincide", "no_coincide", "descriptor_invalido"].every((c) => vistos.has(c)),
  [...vistos].sort().join(", "));

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
