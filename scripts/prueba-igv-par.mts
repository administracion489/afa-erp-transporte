// Matriz de lib/igv-par.ts — npx tsx scripts/prueba-igv-par.mts
import { conIgvDe, sinIgvDe, textoConDesdeSin, textoSinDesdeCon, textoImporte, TASA_IGV } from "../lib/igv-par";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };

console.log("1. Lo tecleado SIN IGV vuelve igual después de pasar por el CON IGV guardado");
{
  // Es el ciclo del formulario: se escribe sin IGV → se guarda el con IGV → al salir del campo se
  // vuelve a pintar el sin IGV derivado. Si no volviera igual, el número cambiaría solo.
  let n = 0, mal = 0;
  for (let c = 0; c <= 5_000_000; c = c < 100_000 ? c + 1 : c + 997) {
    const sin = c / 100; n++;
    const con = conIgvDe(sin);
    if (sinIgvDe(con) !== sin) { if (mal < 5) console.log(`    ${sin} → ${con} → ${sinIgvDe(con)}`); mal++; }
    if (textoSinDesdeCon(textoConDesdeSin(String(sin))) !== String(sin)) mal++;
  }
  ok(mal === 0, `ida y vuelta exacta en ${n} importes (${mal} fallan)`);
}

console.log("2. Lo tecleado CON IGV no se toca, y su sin IGV queda a menos de medio céntimo de con/1.18");
{
  let n = 0, mal = 0;
  for (let c = 0; c <= 2_000_000; c += 7) {
    const con = c / 100; n++;
    const sin = sinIgvDe(con);
    if (Math.abs(sin - con / (1 + TASA_IGV)) > 0.005 + 1e-9) mal++;
    if (Math.round(sin * 100) !== sin * 100 && Math.abs(Math.round(sin * 100) - sin * 100) > 1e-6) mal++;
  }
  ok(mal === 0, `${n} importes con IGV (${mal} fallan)`);
}

console.log("3. El caso de la pantalla (23-10-2026)");
ok(textoConDesdeSin("298.51") === "352.24", `298.51 sin IGV → ${textoConDesdeSin("298.51")} con IGV`);
ok(textoSinDesdeCon("352.24") === "298.51", `352.24 con IGV → ${textoSinDesdeCon("352.24")} sin IGV`);
ok(textoImporte(352.23955799999993) === "352.24", `la cola de coma flotante se limpia al reabrir: ${textoImporte(352.23955799999993)}`);
ok(textoSinDesdeCon("390") === "330.51", `costo interno 390 con IGV → ${textoSinDesdeCon("390")} sin IGV`);
ok(conIgvDe(238.8075) === 281.79, `el costo del calculador (sin IGV) se guarda con IGV: ${conIgvDe(238.8075)}`);

console.log("4. Lo que no es un importe deja el par VACÍO, nunca un cero inventado");
for (const t of ["", "  ", "-", "abc", "-5", "1e", "NaN", "Infinity"]) {
  ok(textoConDesdeSin(t) === "", `sin IGV «${t}» → con IGV «${textoConDesdeSin(t)}»`);
  ok(textoSinDesdeCon(t) === "", `con IGV «${t}» → sin IGV «${textoSinDesdeCon(t)}»`);
}
ok(textoConDesdeSin("0") === "0" && textoSinDesdeCon("0") === "0", "un cero escrito es un cero");
ok(textoConDesdeSin("100.") === "118", `«100.» a medio escribir ya da su par: ${textoConDesdeSin("100.")}`);

console.log("5. textoImporte: lo guardado, listo para el campo");
ok(textoImporte(null) === "" && textoImporte(undefined) === "" && textoImporte("") === "", "sin importe → vacío");
ok(textoImporte(0) === "", "un 0 guardado se pinta vacío, como antes");
ok(textoImporte("400") === "400" && textoImporte(400) === "400", "un entero se pinta tal cual");
ok(textoImporte(340.77572534078996) === "340.78", `al céntimo: ${textoImporte(340.77572534078996)}`);
ok(textoImporte("abc") === "", "un texto que no es número → vacío");

console.log(`\n${oks} OK · ${fallos} fallas`);
if (fallos) process.exit(1);
