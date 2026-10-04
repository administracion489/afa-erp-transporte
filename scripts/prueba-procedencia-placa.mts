// Matriz: una placa que la IA DEDUJO no graba un km en esa unidad.
// Caso real 12/09/2026 21:59: "~Cerna" (número no registrado como conductor) manda una foto
// de tablero con "Kilometraje final unidad en la cochera", sin placa. El Radar grabó 24,484 km
// en la CWZ-371 porque la IA eligió la placa por el parecido del tablero.
// Ejecutar: npx tsx scripts/prueba-procedencia-placa.mts
import { placaEnTexto, procedenciaPlaca } from "../lib/radar/procedencia-placa";

let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fallos++; };

// 1) El caso que se rompió: sin placa escrita y remitente sin asignación → sin respaldo.
ok(procedenciaPlaca({
  placa: "CWZ-371", unidadId: 7,
  textos: ["Kilometraje final unidad en la cochera. Vehículo en la cochera  fin de sevicio", null],
  asignadasAlRemitente: [],
}) === "sin_respaldo", "Cerna 12/09: foto sin placa, número no registrado → SIN RESPALDO (no se graba)");

// 2) Lo legítimo sigue pasando.
ok(procedenciaPlaca({
  placa: "BUI-272", unidadId: 3,
  textos: ["Buenas noches el kilometraje de la móvil placa BUI 2 7 2\nFin de jornada movil en la cochera"],
  asignadasAlRemitente: [],
}) === "texto", "Manuel 12/09: 'placa BUI 2 7 2' en la ráfaga → leída del texto");
ok(procedenciaPlaca({
  placa: "CWZ-371", unidadId: 7, textos: ["km final"], asignadasAlRemitente: [7],
}) === "asignacion", "conductor con la CWZ-371 asignada hoy → respaldada por la asignación");
ok(procedenciaPlaca({
  placa: "CWZ-371", unidadId: 7, textos: ["km final"], asignadasAlRemitente: [3, 7],
}) === "asignacion", "con dos servicios ese día, basta con que una sea esa unidad");
ok(procedenciaPlaca({
  placa: "CWZ-371", unidadId: 7, textos: ["km final"], asignadasAlRemitente: [3],
}) === "sin_respaldo", "conductor con OTRA unidad asignada y sin placa escrita → sin respaldo");

// 3) Formas de escribir la placa.
for (const t of ["CWZ-371", "cwz 371", "C W Z 3 7 1", "placa: Cwz371 llegando"])
  ok(placaEnTexto("CWZ-371", [t]), `reconoce la placa escrita como "${t}"`);
ok(!placaEnTexto("CWZ-371", ["unidad 371 en cochera"]), "un '371' suelto no es la placa");
ok(!placaEnTexto("CWZ-371", ["CWZ-372"]), "otra placa parecida no cuenta");
ok(!placaEnTexto(null, ["CWZ-371"]), "sin placa no hay nada que confirmar");

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
