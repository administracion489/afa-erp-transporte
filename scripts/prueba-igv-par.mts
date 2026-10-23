// Matriz de lib/igv-par.ts — npx tsx scripts/prueba-igv-par.mts
import {
  conIgvDe, sinIgvDe, textoConDesdeSin, textoSinDesdeCon, textoImporte, TASA_IGV,
  margenSinIgv, precioClienteConIgv, precioSinIgvDeFila, precioClienteDesdeConIgv, type FilaMargen,
} from "../lib/igv-par";

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

console.log("6. El margen, SIN IGV en los dos lados");
{
  // El algoritmo VIEJO, copiado literal del formulario (eventual) y del panel de precios: precio
  // guardado − costo CON IGV, sin mirar en qué base está el precio.
  const margenViejo = (f: FilaMargen) => Number(f.precio_cliente || 0) - Number(f.costo_estimado || 0);

  // El caso de la pantalla: 400 sin IGV a un cliente que NO incluye IGV, costo interno 390 con IGV.
  const sinIgv: FilaMargen = { modo_servicio: "eventual", incluye_igv: false, precio_cliente: 400, costo_estimado: 390 };
  const conIgv: FilaMargen = { modo_servicio: "eventual", incluye_igv: true, precio_cliente: 472, costo_estimado: 390 };
  ok(margenViejo(sinIgv) === 10, `el algoritmo viejo reproduce el defecto: margen ${margenViejo(sinIgv)} sobre 400 sin IGV`);
  ok(margenViejo(conIgv) === 82, `…y con el IGV del precio dentro cuando sí lo incluye: ${margenViejo(conIgv)}`);
  ok(margenSinIgv(sinIgv) === 69.49, `no incluye IGV: 400 − 330.51 = ${margenSinIgv(sinIgv)}`);
  ok(margenSinIgv(conIgv) === 69.49, `incluye IGV: 400 − 330.51 = ${margenSinIgv(conIgv)}`);

  // Las tres bases medidas en producción (23-10-2026).
  ok(precioClienteConIgv({ modo_servicio: "eventual", incluye_igv: false }) === false, "eventual sin IGV → precio sin IGV");
  ok(precioClienteConIgv({ modo_servicio: "eventual", incluye_igv: true }) === true, "eventual con IGV → precio con IGV");
  ok(precioClienteConIgv({ modo_servicio: "eventual", incluye_igv: null }) === true, "sin dato → con IGV (la columna nace en true)");
  ok(precioClienteConIgv({ modo_servicio: null, incluye_igv: undefined }) === true, "fila sin modo ni IGV → con IGV");
  ok(precioClienteConIgv({ modo_servicio: "fijo", incluye_igv: false, precio_dia: 350 }) === true, "fija con precio/día → con IGV aunque no incluya IGV");
  ok(precioClienteConIgv({ modo_servicio: "fijo", incluye_igv: false, precio_dia: null }) === false, "fija sin precio/día → sigue la regla de la eventual");
  ok(precioClienteConIgv({ modo_servicio: "fijo", incluye_igv: false, precio_dia: "0" }) === false, "un precio/día en 0 no es un precio/día");
  ok(margenSinIgv({ modo_servicio: "fijo", incluye_igv: true, precio_cliente: 352.24, precio_dia: 352.24, costo_estimado: 281.79 }) === 59.70,
    `fija: 298.51 − 238.81 = ${margenSinIgv({ modo_servicio: "fijo", incluye_igv: true, precio_cliente: 352.24, precio_dia: 352.24, costo_estimado: 281.79 })} por día`);

  // Sin costo o sin precio no hay margen: ni el precio entero ni un cero inventado.
  for (const costo of [null, undefined, "", 0, "0", -5, "abc"])
    ok(margenSinIgv({ incluye_igv: true, precio_cliente: 472, costo_estimado: costo as any }) === null, `costo «${String(costo)}» → sin margen`);
  for (const precio of [null, undefined, "", 0, -1, "x"])
    ok(margenSinIgv({ incluye_igv: true, precio_cliente: precio as any, costo_estimado: 390 }) === null, `precio «${String(precio)}» → sin margen`);
  ok(margenSinIgv({ incluye_igv: false, precio_cliente: "400", costo_estimado: "390" }) === 69.49, "los importes llegan también como texto (numeric de PostgREST)");
  ok(margenSinIgv({ incluye_igv: true, precio_cliente: 100, costo_estimado: 200 }) === -84.74, `margen negativo: 84.75 − 169.49 = ${margenSinIgv({ incluye_igv: true, precio_cliente: 100, costo_estimado: 200 })}`);

  // Barrido: el MISMO negocio (subtotal y costo sin IGV) da el MISMO margen se cotice con IGV o sin
  // él, y es su diferencia sin IGV a ±1 céntimo (dos redondeos al céntimo).
  let n = 0, mal = 0, dif = 0;
  for (let sc = 1; sc <= 300_000; sc += 37) {
    for (const cc of [1, 1999, 23_881, 33_051, sc, Math.round(sc * 0.7), sc + 113]) {
      const s = sc / 100, c = cc / 100; n++;
      const costo = conIgvDe(c);
      const a = margenSinIgv({ modo_servicio: "eventual", incluye_igv: false, precio_cliente: s, costo_estimado: costo });
      const b = margenSinIgv({ modo_servicio: "eventual", incluye_igv: true, precio_cliente: s * 1.18, costo_estimado: costo });
      const f = margenSinIgv({ modo_servicio: "fijo", incluye_igv: false, precio_cliente: conIgvDe(s), precio_dia: conIgvDe(s), costo_estimado: costo });
      if (a == null || b == null || f == null) { mal++; continue; }
      if (Math.abs(a - (s - c)) > 0.0100001 || Math.abs(b - (s - c)) > 0.0100001 || Math.abs(f - (s - c)) > 0.0100001) mal++;
      if (a !== b) dif++;
      if (Math.round(a * 100) !== a * 100 && Math.abs(Math.round(a * 100) - a * 100) > 1e-6) mal++;
    }
  }
  ok(mal === 0, `${n} negocios: margen = subtotal − costo, sin IGV, a ±1 céntimo (${mal} fallan)`);
  ok(dif <= n * 0.02, `con o sin IGV, el mismo margen salvo el céntimo de un empate (${dif} de ${n})`);

  // El cotizador: precio del 20 % con IGV y costo del calculador sin IGV, guardado con IGV.
  let malCot = 0;
  for (let b = 1; b <= 400_000; b += 61) {
    const base = b / 100 + 0.0037, sin20 = base / 0.8, con20 = sin20 * 1.18;
    const m = margenSinIgv({ modo_servicio: "eventual", incluye_igv: true, precio_cliente: con20, costo_estimado: conIgvDe(base) });
    if (m == null || Math.abs(m - (sin20 - base)) > 0.0150001) malCot++;
  }
  ok(malCot === 0, `cotizador: el margen guardado es el del 20 % sin IGV (sinIGV20 − baseCosto) a ±1.5 céntimos (${malCot} fallan)`);

  // Escribir con una base y leer con otra: un precio CON IGV del panel de precios se escribe en la
  // base de la fila y se vuelve a leer como el mismo precio sin IGV.
  let malCiclo = 0;
  for (const fila of [
    { modo_servicio: "eventual", incluye_igv: false }, { modo_servicio: "eventual", incluye_igv: true },
    { modo_servicio: "eventual", incluye_igv: null }, { modo_servicio: "fijo", incluye_igv: false, precio_dia: 300 },
    { modo_servicio: "fijo", incluye_igv: false, precio_dia: null }, { modo_servicio: "fijo", incluye_igv: true, precio_dia: null },
  ] as FilaMargen[]) {
    for (let c = 1; c <= 500_000; c += 173) {
      const con = c / 100;
      const escrito = precioClienteDesdeConIgv(fila, con);
      if (precioSinIgvDeFila({ ...fila, precio_cliente: escrito }) !== sinIgvDe(con)) malCiclo++;
    }
  }
  ok(malCiclo === 0, `panel de precios: lo escrito se lee en su base (${malCiclo} fallan)`);
  ok(precioClienteDesdeConIgv({ incluye_igv: false }, 472) === 400, "a una cotización sin IGV, 472 con IGV se escribe como 400");
  ok(precioClienteDesdeConIgv({ incluye_igv: true }, 472.004) === 472.004, "a una con IGV se escribe tal cual, como antes");
}

console.log(`\n${oks} OK · ${fallos} fallas`);
if (fallos) process.exit(1);
