// Matriz: la confirmación del km en la app del conductor.
// Caso real: D4V-955 02/10/2026 — tablero ODO 178227, entró 15,700,000 km.
// Ejecutar: npx tsx scripts/prueba-km-confirmacion.mts
import { juzgarKmConductor, coincideReescrito } from "../lib/odometro-confirmacion";

let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fallos++; };

ok(juzgarKmConductor({ km: 15_700_000, kmVigente: 178_100 }).nivel === "revisar", "D4V-955: 15,700,000 con vigente 178,100 → hay que reescribirlo");
ok(juzgarKmConductor({ km: 15_700_000 }).nivel === "revisar", "8 dígitos sin vigente conocido → reescribir (forma imposible)");
ok(juzgarKmConductor({ km: 178_227, kmVigente: 178_100, kmOcr: 178_227 }).nivel === "ok", "lectura normal → basta un toque");
ok(juzgarKmConductor({ km: 178_227, kmVigente: 178_300 }).nivel === "revisar", "menor al vigente → reescribir");
ok(juzgarKmConductor({ km: 185_000, kmVigente: 178_100 }).nivel === "revisar", "+6,900 km sobre el vigente → reescribir");
ok(juzgarKmConductor({ km: 179_500, kmVigente: 178_100 }).nivel === "ok", "+1,400 km (una jornada larga) → un toque");
ok(juzgarKmConductor({ km: 178_227, kmVigente: 178_100, kmOcr: 1_782_277 }).nivel === "revisar", "lo tecleado difiere de lo que leyó la IA → reescribir");
ok(juzgarKmConductor({ km: 250, kmVigente: 0 }).nivel === "ok", "unidad nueva con 250 km → un toque");
ok(juzgarKmConductor({ km: 12 }).nivel === "revisar", "2 dígitos → reescribir");
for (const r of juzgarKmConductor({ km: 15_700_000, kmVigente: 178_100 }).motivos) ok(r.length > 10, `motivo legible: ${r}`);

ok(coincideReescrito(15_700_000, "15.700.000"), "reescrito con puntos coincide");
ok(coincideReescrito(178227, " 178 227 "), "reescrito con espacios coincide");
ok(!coincideReescrito(15_700_000, "178227"), "otro número no coincide");
ok(!coincideReescrito(178227, ""), "vacío no confirma");

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
