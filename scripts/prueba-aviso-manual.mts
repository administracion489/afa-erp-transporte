// npx tsx scripts/prueba-aviso-manual.mts
// El aviso manual a pasajeros: nunca un servicio pasado, nunca dos veces a quien ya lo recibió
// (salvo cambio de hora). Trae los dos casos reales del 01–12/10/2026.
import { planAvisoManual, servicioPasado, textoPlanAvisoManual } from "../lib/notificaciones-manual.ts";

let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };

const HOY = "2026-10-09";

// Caso 18394: tres pulsaciones en 4 minutos a los mismos 5.
const pax = [1, 2, 3, 4, 5];
const p1 = planAvisoManual({ fechaServicio: "2026-10-10", hoy: HOY, motivo: "manifiesto", pasajeros: pax, avisadosAntes: [] });
ok(p1.codigo === "avisar" && p1.avisar.length === 5, "primera pulsación avisa a los 5");
const p2 = planAvisoManual({ fechaServicio: "2026-10-10", hoy: HOY, motivo: "manifiesto", pasajeros: pax, avisadosAntes: pax });
ok(p2.codigo === "todos_avisados" && p2.avisar.length === 0, "segunda pulsación no repite a nadie");
const p3 = planAvisoManual({ fechaServicio: "2026-10-10", hoy: HOY, motivo: "manifiesto", pasajeros: [...pax, 6], avisadosAntes: pax });
ok(p3.codigo === "avisar" && p3.avisar.join() === "6" && p3.yaAvisados.length === 5, "con un pasajero nuevo, solo a él");

// Caso 16582/28071: servicios del 25/09 y 22/08 avisados el 02/10.
for (const f of ["2026-09-25", "2026-08-22", "2026-10-08"]) {
  const p = planAvisoManual({ fechaServicio: f, hoy: HOY, motivo: "manifiesto", pasajeros: pax, avisadosAntes: [] });
  ok(p.codigo === "servicio_pasado" && p.avisar.length === 0, `servicio del ${f} no se avisa`);
  const c = planAvisoManual({ fechaServicio: f, hoy: HOY, motivo: "cambio_hora", pasajeros: pax, avisadosAntes: [] });
  ok(c.avisar.length === 0, `ni con cambio de hora (${f})`);
}

// Hoy sí se avisa; sin fecha no se afirma que pasó.
ok(!servicioPasado(HOY, HOY), "hoy no es pasado");
ok(!servicioPasado(null, HOY), "sin fecha no es pasado");

// Cambio de hora corrige: repite a todos.
const ch = planAvisoManual({ fechaServicio: "2026-10-10", hoy: HOY, motivo: "cambio_hora", pasajeros: pax, avisadosAntes: pax });
ok(ch.codigo === "avisar" && ch.avisar.length === 5, "cambio de hora re-avisa a todos");

ok(planAvisoManual({ fechaServicio: "2026-10-10", hoy: HOY, motivo: "manifiesto", pasajeros: [], avisadosAntes: [] }).codigo === "sin_pasajeros", "sin pasajeros");

// Invariante por barrido: avisar ∩ yaAvisados = ∅, avisar ⊆ pasajeros, en manifiesto nunca un ya avisado,
// y en pasado nunca nadie. Corolario: con alguien nuevo y servicio vigente, se avisa.
let barrido = 0;
for (const f of ["2026-10-08", "2026-10-09", "2026-10-10", null])
  for (const motivo of ["manifiesto", "cambio_hora"] as const)
    for (let mask = 0; mask < 64; mask++) {
      const antes = pax.filter((_, i) => mask & (1 << i));
      const p = planAvisoManual({ fechaServicio: f, hoy: HOY, motivo, pasajeros: pax, avisadosAntes: antes });
      barrido++;
      const inter = p.avisar.some((x) => p.yaAvisados.includes(x));
      const fuera = p.avisar.some((x) => !pax.includes(x));
      const repite = motivo === "manifiesto" && p.avisar.some((x) => antes.includes(x));
      const pasadoAvisa = f === "2026-10-08" && p.avisar.length > 0;
      const nuevoSinAviso = f !== "2026-10-08" && antes.length < pax.length && p.avisar.length === 0;
      if (inter || fuera || repite || pasadoAvisa || nuevoSinAviso) { fallos++; console.log("✗ barrido", f, motivo, mask); }
      if (!textoPlanAvisoManual(p)) { fallos++; console.log("✗ sin texto", p.codigo); }
    }
console.log(`barrido: ${barrido} combinaciones`);

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
