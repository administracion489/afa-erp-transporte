// npx tsx scripts/prueba-crm-ia-reactivacion.mts
import { inicioVentanaHumano, inicioConteoTurnos, hayClienteEsperando, horasPausaHumano, HORAS_PAUSA_DEFECTO, MARGEN_RELOJ_REACTIVACION_MS, reactivacionValida } from "../lib/crm-ia-reactivacion";
let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };

const ahora = Date.parse("2026-10-20T15:00:00Z");
const h12 = new Date(ahora - 12 * 3600_000).toISOString();

// Sin reactivación: byte a byte lo de antes.
ok(inicioVentanaHumano(ahora, 12, null) === h12, "sin reactivación → hace 12 h");
ok(inicioVentanaHumano(ahora, 12, undefined) === h12, "undefined (sin migración) → hace 12 h");
ok(inicioVentanaHumano(ahora, 12, "basura") === h12, "fecha ilegible → hace 12 h");

// EL CASO: una persona respondió hace 1 h y después alguien reactivó la IA hace 5 min.
const respondioHumano = ahora - 3600_000;
const reactivo = new Date(ahora - 5 * 60_000).toISOString();
const desde = inicioVentanaHumano(ahora, 12, reactivo);
ok(Date.parse(desde) > respondioHumano, "la respuesta humana ANTERIOR a reactivar ya no aparta a la IA");
ok(desde === new Date(reactivo).toISOString(), "la ventana empieza en la reactivación");

// Una persona que responde DESPUÉS de reactivar vuelve a apartar a la IA.
const despues = ahora - 60_000;
ok(despues >= Date.parse(desde), "respuesta humana posterior sí cuenta");

// Una reactivación de hace días no AMPLÍA la ventana: sigue siendo 12 h.
ok(inicioVentanaHumano(ahora, 12, "2026-10-10T00:00:00Z") === h12, "reactivación vieja no alarga la ventana");

// Barrido: la ventana nunca es más larga que N horas ni empieza antes de la reactivación.
for (let horas = 1; horas <= 48; horas += 7)
  for (let m = -3000; m <= 0; m += 37) {
    const r = new Date(ahora + m * 60_000).toISOString();
    const d = Date.parse(inicioVentanaHumano(ahora, horas, r));
    if (d < ahora - horas * 3600_000 || d < Date.parse(r)) { fallos++; console.log("✗ barrido", horas, m); }
  }
console.log("✓ barrido de ventanas");

// Turnos: sin reactivación cuenta todo; con ella, desde ella.
ok(inicioConteoTurnos(null) === null, "sin reactivación → cuenta toda la conversación");
ok(inicioConteoTurnos(reactivo) === new Date(reactivo).toISOString(), "con reactivación → solo los turnos posteriores");
ok(inicioConteoTurnos("x") === null, "fecha ilegible → toda la conversación (lado seguro)");

// ¿Contesta en el momento?
ok(hayClienteEsperando({ direccion: "entrante" }), "último del cliente → contesta ya");
ok(!hayClienteEsperando({ direccion: "saliente" }), "último nuestro → espera al cliente");
ok(!hayClienteEsperando(null), "chat vacío → nada que contestar");

// Una reactivación en el FUTURO (alguien escribió ia_reactivada_at = 2099 a mano para que la pausa no
// cuente): más allá de MARGEN_RELOJ_REACTIVACION_MS se ignora, dentro del margen sí cuenta.
const M = MARGEN_RELOJ_REACTIVACION_MS;
ok(M === 5 * 60_000, "el margen del reloj es de 5 min");
ok(inicioVentanaHumano(ahora, 12, "2099-01-01T00:00:00Z") === h12, "reactivación en 2099 → la ventana de siempre (12 h)");
ok(inicioVentanaHumano(ahora, 12, new Date(ahora + M + 1).toISOString()) === h12, "a +5 min y 1 ms → la ventana de siempre");
ok(inicioVentanaHumano(ahora, 12, new Date(ahora + 4 * 60_000).toISOString()) === new Date(ahora + 4 * 60_000).toISOString(), "a +4 min (reloj desfasado) → cuenta");
ok(inicioVentanaHumano(ahora, 12, new Date(ahora + M).toISOString()) === new Date(ahora + M).toISOString(), "a +5 min exactos → cuenta");
ok(inicioConteoTurnos("2099-01-01T00:00:00Z", ahora) === null && inicioConteoTurnos(reactivo, ahora) === new Date(reactivo).toISOString(), "turnos: con «ahora», la de 2099 no cuenta (toda la conversación) y la real sí");
ok(inicioConteoTurnos("2099-01-01T00:00:00Z") === "2099-01-01T00:00:00.000Z", "turnos sin «ahora»: la lectura de siempre (byte a byte)");
ok(reactivacionValida(null, ahora) === null && reactivacionValida("x", ahora) === null && reactivacionValida(reactivo, ahora) === Date.parse(reactivo), "reactivacionValida");
// Barrido: con cualquier reactivación futura más allá del margen, la ventana es la de siempre.
for (let h = 1; h <= 48; h += 11) for (let m = 6; m <= 600000; m = m * 3) {
  if (inicioVentanaHumano(ahora, h, new Date(ahora + m * 60_000).toISOString()) !== new Date(ahora - h * 3600_000).toISOString()) { fallos++; console.log("✗ futura", h, m); }
}
console.log("✓ barrido de reactivaciones futuras");

// La pausa del agente (se mudó aquí desde lib/crm-ia.ts, que la reexporta): la misma lectura de siempre.
ok(horasPausaHumano({}) === HORAS_PAUSA_DEFECTO && HORAS_PAUSA_DEFECTO === 12 && horasPausaHumano(null) === 12, "sin número → 12 h");
ok(horasPausaHumano({ pausa_humano_horas: null }) === 0 && horasPausaHumano({ pausa_humano_horas: "6" }) === 6 && horasPausaHumano({ pausa_humano_horas: "x" }) === 12, "null → 0 (apagada), «6» → 6, basura → 12");

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
