// Matriz del CALENDARIO LABORAL (lib/comisiones/calendario.ts). Funciones puras, sin base.
// Uso:  npx tsx scripts/prueba-calendario-laboral.mts   (sale con código 1 si algo falla)
//
// Fija: sábado/domingo no son hábiles, un feriado de Perú (28 de julio, Fiestas Patrias,
// pasado como parámetro — NADA de feriados escritos en el código) tampoco, y que
// `horasHabilesEntre` cuenta solo la jornada, cruzando la noche y el fin de semana.

import {
  esDiaHabil,
  esFinDeSemana,
  esFeriado,
  horasHabilesEntre,
  dentroDePlazoHabil,
  sumarDias,
  sumarMeses,
} from "../lib/comisiones/calendario";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// Perú 2026: 28 de julio (Fiestas Patrias) es feriado. Se pasa como parámetro.
const FERIADOS = ["2026-07-28", "2026-07-29"];

// Fechas conocidas de 2026: 2026-07-25 es SÁBADO, 2026-07-26 domingo, 2026-07-27 lunes,
// 2026-07-28 martes (feriado), 2026-07-30 jueves hábil.
console.log("\n════ Días hábiles ════\n");
chk("2026-07-25 es sábado → fin de semana", esFinDeSemana("2026-07-25"));
chk("2026-07-26 es domingo → fin de semana", esFinDeSemana("2026-07-26"));
chk("2026-07-27 (lunes) no es fin de semana", !esFinDeSemana("2026-07-27"));
chk("sábado NO es día hábil", !esDiaHabil("2026-07-25", FERIADOS));
chk("28-jul (feriado de Perú) NO es día hábil", esFeriado("2026-07-28", FERIADOS) && !esDiaHabil("2026-07-28", FERIADOS));
chk("2026-07-30 (jueves, no feriado) SÍ es día hábil", esDiaHabil("2026-07-30", FERIADOS));
chk("un lunes común con lista de feriados vacía es hábil", esDiaHabil("2026-07-27", []));

console.log("\n════ Horas hábiles (jornada 09:00–18:00) ════\n");
const J = { feriados: FERIADOS, horaInicio: 9, horaFin: 18 };
// Lima es UTC-5: las 00:00 de Lima son las 05:00 UTC. Construyo instantes con ese offset.
const limaMs = (iso: string, h: number, m = 0) => Date.parse(`${iso}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-05:00`);

// Mismo día: de 10:00 a 15:00 → 5 horas.
chk("mismo día 10→15 = 5 h", horasHabilesEntre(limaMs("2026-07-30", 10), limaMs("2026-07-30", 15), J) === 5);

// Se recorta a la jornada: de 07:00 a 20:00 → solo 09–18 = 9 h.
chk("fuera de jornada se recorta (07→20 = 9 h)", horasHabilesEntre(limaMs("2026-07-30", 7), limaMs("2026-07-30", 20), J) === 9);

// Cruzando la noche: jueves 16:00 → viernes 11:00 = 2 h (jueves) + 2 h (viernes) = 4 h.
// 2026-07-30 jueves, 2026-07-31 viernes (ambos hábiles).
chk("cruza la noche (jue 16:00 → vie 11:00 = 4 h)", horasHabilesEntre(limaMs("2026-07-30", 16), limaMs("2026-07-31", 11), J) === 4, String(horasHabilesEntre(limaMs("2026-07-30", 16), limaMs("2026-07-31", 11), J)));

// Cruzando el fin de semana: viernes 16:00 → lunes 11:00.
// 2026-07-31 viernes, 08-01 sábado, 08-02 domingo, 08-03 lunes. = 2 h (vie) + 0 + 0 + 2 h (lun) = 4 h.
chk("cruza el fin de semana (vie 16:00 → lun 11:00 = 4 h)", horasHabilesEntre(limaMs("2026-07-31", 16), limaMs("2026-08-03", 11), J) === 4, String(horasHabilesEntre(limaMs("2026-07-31", 16), limaMs("2026-08-03", 11), J)));

// Cruzando un feriado: lunes 27-jul 16:00 → jueves 30-jul 11:00.
// lun 27 (16→18 = 2h), mar 28 feriado (0), mié 29 feriado (0), jue 30 (9→11 = 2h) = 4 h.
chk("salta el feriado (lun 27 16:00 → jue 30 11:00 = 4 h, martes y miércoles feriados)", horasHabilesEntre(limaMs("2026-07-27", 16), limaMs("2026-07-30", 11), J) === 4, String(horasHabilesEntre(limaMs("2026-07-27", 16), limaMs("2026-07-30", 11), J)));

// Un intervalo entero dentro del fin de semana = 0.
chk("todo el intervalo en fin de semana = 0 h", horasHabilesEntre(limaMs("2026-08-01", 10), limaMs("2026-08-02", 15), J) === 0);

// Fin ≤ inicio → 0.
chk("fin ≤ inicio = 0 h", horasHabilesEntre(limaMs("2026-07-30", 15), limaMs("2026-07-30", 10), J) === 0);

console.log("\n════ Plazo hábil (registros al día) ════\n");
// Respuesta el viernes 16:00 a algo ocurrido el viernes 14:00: 2 h ≤ plazo 4 h → en plazo.
chk("respuesta en 2 h hábiles ≤ plazo 4 h → en plazo", dentroDePlazoHabil(limaMs("2026-07-31", 14), limaMs("2026-07-31", 16), 4, J));
// Ocurrido viernes 17:30, respondido lunes 10:00: 0.5 h (vie) + 1 h (lun) = 1.5 h ≤ 4 → en plazo.
chk("viernes tarde → lunes temprano = 1.5 h hábiles ≤ 4 → en plazo", dentroDePlazoHabil(limaMs("2026-07-31", 17, 30), limaMs("2026-08-03", 10), 4, J), String(horasHabilesEntre(limaMs("2026-07-31", 17, 30), limaMs("2026-08-03", 10), J)));
// Ocurrido viernes 10:00, respondido lunes 15:00: 8 h (vie) + 6 h (lun) = 14 h > plazo 4 → fuera.
chk("viernes 10:00 → lunes 15:00 = 14 h hábiles > 4 → fuera de plazo", !dentroDePlazoHabil(limaMs("2026-07-31", 10), limaMs("2026-08-03", 15), 4, J));

console.log("\n════ Aritmética ISO ════\n");
chk("sumarDias cruza mes (2026-07-31 +1 = 2026-08-01)", sumarDias("2026-07-31", 1) === "2026-08-01");
chk("sumarDias resta (2026-08-01 -1 = 2026-07-31)", sumarDias("2026-08-01", -1) === "2026-07-31");
chk("sumarMeses +12 (2027-03-15 → 2028-03-15)", sumarMeses("2027-03-15", 12) === "2028-03-15");
chk("sumarMeses -12 (2027-06-20 → 2026-06-20)", sumarMeses("2027-06-20", -12) === "2026-06-20");
chk("sumarMeses recorta fin de mes (2027-01-31 +1 = 2027-02-28)", sumarMeses("2027-01-31", 1) === "2027-02-28");
chk("sumarMeses cruza año (2027-11-15 +3 = 2028-02-15)", sumarMeses("2027-11-15", 3) === "2028-02-15");

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
