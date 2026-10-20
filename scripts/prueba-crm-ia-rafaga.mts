// npx tsx scripts/prueba-crm-ia-rafaga.mts
// Ráfaga de mensajes del cliente: la IA no puede callar un mensaje que su última respuesta no leyó.
import {
  CONTESTA, MARGEN_RELOJ_MS, juzgarUltimo, leerMarca, loVio, marcaVigente, ordenarRafaga,
  type MarcaRespuesta, type MensajeRafaga,
} from "../lib/crm-ia-rafaga";

let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };
const iso = (ms: number) => new Date(ms).toISOString();

// ── 1. EL CASO REAL (conversación fc7ae01f…, 20-10-2026, hora UTC) ─────────────────────────
const conv: MensajeRafaga[] = [
  { id: "doc", direccion: "entrante", created_at: "2026-10-20T14:35:54.255Z" },
  { id: "r0", direccion: "saliente", created_at: "2026-10-20T14:36:12.642Z", generado_por_ia: true },
  { id: "e0", direccion: "entrante", created_at: "2026-10-20T14:36:18.016Z" },
  { id: "r1", direccion: "saliente", created_at: "2026-10-20T14:36:41.768Z", generado_por_ia: true },
  { id: "m1", direccion: "entrante", created_at: "2026-10-20T14:36:57.982Z" }, // «cotízame un bus 50…»
  { id: "m2", direccion: "entrante", created_at: "2026-10-20T14:37:26.565Z" }, // «Del hotel casa andina. Con maletas»
  { id: "m3", direccion: "entrante", created_at: "2026-10-20T14:37:51.278Z" }, // «Fecha 25 diciembre hora 3:00 pm»
  { id: "r2", direccion: "saliente", created_at: "2026-10-20T14:37:56.509Z", generado_por_ia: true }, // pidió fecha, hora y maletas
];
const porId = (id: string) => conv.find((m) => m.id === id)!;
// La corrida de m2 leyó hasta m2 y terminó de enviar justo después de registrar r2.
const marcaCaso: MarcaRespuesta = { visto_id: "m2", visto_at: porId("m2").created_at, hasta: "2026-10-20T14:37:56.700Z" };
const ultimo = conv[conv.length - 1];

// El algoritmo VIEJO, copiado literal: con el último mensaje nuestro, la corrida de m3 se retiraba.
const viejoCalla = (ult: { direccion: string } | null) => ult?.direccion === "saliente";
ok(viejoCalla(ultimo), "regresión: el algoritmo viejo se calla ante m3 (el defecto se reproduce)");

ok(juzgarUltimo(ultimo, porId("m3"), marcaCaso) === "no_lo_vio", "EL CASO: la respuesta r2 no leyó m3 → la corrida de m3 contesta");
ok(CONTESTA[juzgarUltimo(ultimo, porId("m3"), marcaCaso)], "…y CONTESTA lo dice");
ok(juzgarUltimo(ultimo, porId("m2"), marcaCaso) === "ya_contestado", "la corrida de m2 (duplicada) no vuelve a contestar: r2 leyó m2");

const reordenado = ordenarRafaga(conv, marcaCaso).map((m) => m.id).join(",");
ok(reordenado === "doc,r0,e0,r1,m1,m2,r2,m3", `el modelo lee «pedí la fecha → me dio la fecha»: ${reordenado}`);
ok(ordenarRafaga(conv, null) === conv, "sin marca el historial es el de siempre (la misma lista)");

// ── 2. Lo que NO se afloja ─────────────────────────────────────────────────────────────────
const persona: MensajeRafaga = { id: "h", direccion: "saliente", created_at: "2026-10-20T14:37:56.509Z", generado_por_ia: false };
ok(juzgarUltimo(persona, porId("m3"), marcaCaso) === "respondio_persona", "una respuesta de una PERSONA al final: la IA no interviene");
const sinFlag: MensajeRafaga = { id: "h2", direccion: "saliente", created_at: "2026-10-20T14:37:56.509Z" };
ok(juzgarUltimo(sinFlag, porId("m3"), marcaCaso) === "respondio_persona", "saliente sin saber de quién: como persona (lado seguro)");
ok(juzgarUltimo(ultimo, porId("m3"), null) === "ya_contestado", "sin marca (sin columna, o respuesta anterior al cambio): como antes");
ok(juzgarUltimo(ultimo, null, marcaCaso) === "ya_contestado", "sin mensaje propio: como antes");
const tardia: MensajeRafaga = { id: "r9", direccion: "saliente", created_at: iso(Date.parse(marcaCaso.hasta) + MARGEN_RELOJ_MS + 1), generado_por_ia: true };
ok(juzgarUltimo(tardia, porId("m3"), marcaCaso) === "ya_contestado", "una respuesta de la IA POSTERIOR a la marca no es la que la marca describe");
ok(juzgarUltimo({ ...porId("m3") }, porId("m3"), marcaCaso) === "cliente_espera", "último del cliente: contesta");
ok(juzgarUltimo(null, porId("m3"), marcaCaso) === "cliente_espera", "sin mensajes: no es «ya contestado»");
ok(loVio({ id: "m2", created_at: "2099-01-01T00:00:00Z" }, marcaCaso), "el mensaje marcado como visto cuenta visto aunque su hora diga otra cosa");
ok(loVio({ id: "x", created_at: "basura" }, marcaCaso), "hora ilegible: no se afirma que no lo vio");

// ── 3. La marca: forma exacta, y sobrevive a lo que no envía ────────────────────────────────
ok(leerMarca({ marca: marcaCaso })?.visto_id === "m2", "lee la marca de ia_ultima_decision");
for (const malo of [null, {}, { marca: null }, { marca: "x" }, { marca: { visto_id: "", visto_at: marcaCaso.visto_at, hasta: marcaCaso.hasta } },
  { marca: { visto_id: "m2", visto_at: "x", hasta: marcaCaso.hasta } }, { marca: { visto_id: "m2", visto_at: marcaCaso.hasta, hasta: marcaCaso.visto_at } }])
  ok(leerMarca(malo) === null, `marca inválida → null: ${JSON.stringify(malo)}`);
ok(marcaVigente(null, { accion: "omitido", marca: marcaCaso })?.visto_id === "m2", "una decisión que no envía conserva la marca anterior");
const nueva: MarcaRespuesta = { visto_id: "m3", visto_at: porId("m3").created_at, hasta: "2026-10-20T14:38:20.000Z" };
ok(marcaVigente(nueva, { marca: marcaCaso })?.visto_id === "m3", "una respuesta enviada reemplaza la marca");

// ── 4. Simulación de la carrera: cuándo se comprueba «¿siguió escribiendo?» ────────────────
// La corrida de m2 termina de redactar en Tc, espera D (delay_segundos), comprueba y envía; Meta
// tarda L en aceptar y el mensaje queda registrado en Tc+D+L. m3 llega en t3. Después, la corrida
// de m3 toma el turno. ¿Queda m3 sin contestar?
function m3SinContestar(politica: "vieja" | "nueva", Tc: number, D: number, L: number, t3: number): boolean {
  const chequeo = politica === "vieja" ? Tc : Tc + D; // lo nuevo: la espera va ANTES de comprobar
  if (t3 < chequeo) return false; // la corrida de m2 se retira y la de m3 contesta todo junto
  const tRespuesta = Tc + D + L;
  if (t3 > tRespuesta) return false; // m3 es el último mensaje: se contesta como siempre
  const ult: MensajeRafaga = { id: "r", direccion: "saliente", created_at: iso(tRespuesta), generado_por_ia: true };
  const propio = { id: "m3", created_at: iso(t3) };
  if (politica === "vieja") return viejoCalla(ult);
  const marca: MarcaRespuesta = { visto_id: "m2", visto_at: iso(Tc - 20_000), hasta: iso(tRespuesta + 50) };
  return !CONTESTA[juzgarUltimo(ult, propio, marca)];
}
let perdidosViejo = 0, perdidosNuevo = 0, casos = 0;
const T0 = Date.parse("2026-10-20T14:37:50Z");
for (const D of [0, 2_000, 5_000, 15_000])
  for (const L of [100, 800, 2_500])
    for (let dt = -5_000; dt <= D + L + 5_000; dt += 37) {
      casos++;
      if (m3SinContestar("vieja", T0, D, L, T0 + dt)) perdidosViejo++;
      if (m3SinContestar("nueva", T0, D, L, T0 + dt)) perdidosNuevo++;
    }
ok(perdidosViejo > 0, `regresión: con el orden viejo m3 se pierde en ${perdidosViejo} de ${casos} desfases`);
ok(perdidosNuevo === 0, `con la espera antes de comprobar y la marca, ningún mensaje queda sin contestar (${casos} desfases)`);

// ── 5. Barrido de ordenarRafaga: no pierde, no duplica, no desordena lo que no toca ────────
let semilla = 7;
const azar = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648;
let barridos = 0, movidos = 0;
for (let k = 0; k < 4000; k++) {
  const n = 2 + Math.floor(azar() * 12);
  let t = Date.parse("2026-10-20T14:00:00Z");
  const msgs: MensajeRafaga[] = [];
  for (let i = 0; i < n; i++) {
    t += Math.floor(azar() * 20_000);
    const sal = azar() < 0.4;
    msgs.push({ id: `x${i}`, direccion: sal ? "saliente" : "entrante", created_at: iso(t), generado_por_ia: sal ? azar() < 0.8 : false });
  }
  const ents = msgs.filter((m) => m.direccion === "entrante");
  if (!ents.length) continue;
  const visto = ents[Math.floor(azar() * ents.length)];
  const marca: MarcaRespuesta = { visto_id: visto.id, visto_at: visto.created_at, hasta: iso(Date.parse(visto.created_at) + Math.floor(azar() * 60_000)) };
  const out = ordenarRafaga(msgs, marca);
  barridos++;
  const ids = (l: MensajeRafaga[]) => l.map((m) => m.id);
  if (out.length !== msgs.length || new Set(ids(out)).size !== msgs.length || ids(out).some((id) => !msgs.find((m) => m.id === id))) {
    fallos++; console.log("✗ barrido: perdió o duplicó", k); continue;
  }
  // Los mensajes del cliente siguen en su orden, y nuestras respuestas también.
  const sub = (l: MensajeRafaga[], d: string) => ids(l.filter((m) => m.direccion === d)).join(",");
  if (sub(out, "entrante") !== sub(msgs, "entrante") || sub(out, "saliente") !== sub(msgs, "saliente")) {
    fallos++; console.log("✗ barrido: cambió el orden de un mismo lado", k); continue;
  }
  // Ningún mensaje que la respuesta SÍ leyó cambia de lugar respecto de esa respuesta.
  const pos = new Map(ids(out).map((id, i) => [id, i]));
  const posAnt = new Map(ids(msgs).map((id, i) => [id, i]));
  for (const m of msgs) {
    if (m.direccion !== "entrante" || !loVio(m, marca)) continue;
    for (const r of msgs) if (r.direccion === "saliente" && (posAnt.get(m.id)! < posAnt.get(r.id)!) !== (pos.get(m.id)! < pos.get(r.id)!)) {
      fallos++; console.log("✗ barrido: movió un mensaje que la respuesta leyó", k);
    }
  }
  if (ids(out).join() !== ids(msgs).join()) movidos++;
}
ok(movidos > 0, `el barrido sí reordena (${movidos} de ${barridos} historiales): no es trivial`);
console.log(`✓ barrido de ${barridos} historiales sin pérdidas ni duplicados`);

console.log(fallos ? `\n✗ ${fallos} fallo(s)` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
