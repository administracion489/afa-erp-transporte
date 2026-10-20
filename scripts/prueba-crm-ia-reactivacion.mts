// npx tsx scripts/prueba-crm-ia-reactivacion.mts
import { inicioVentanaHumano, inicioConteoTurnos, hayClienteEsperando } from "../lib/crm-ia-reactivacion";
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

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
