// Pruebas del costo EMPRESA de un conductor. No tocan la base.
// Uso:  npx tsx scripts/prueba-conductor.mts   (sale con código 1 si algo falla)
//
// Cubren lo que de verdad se puede equivocar aquí: los factores de cada uno de los
// tres regímenes peruanos, que la asignación familiar entre en la base de EsSalud y
// de la gratificación (y no solo se sume al final), que el sueldo de planilla se
// PRORRATEE en vez de imputarse entero a cada servicio, y que ningún divisor en
// cero produzca Infinity — que es un número que llegaría hasta el precio ofertado.

import {
  costoEmpresaMes, costoConductorServicio,
  type RegimenLaboral, type DatosConductor,
} from "../lib/costeo-conductor";

// Los tres regímenes, con los mismos valores que siembra
// supabase/costeo-01-planilla-y-presupuesto.sql.
const MICRO: RegimenLaboral = {
  regimen: "microempresa", nombre: "Microempresa",
  essalud_pct: 0, usa_sis: true, sis_aporte_mensual: 0,
  gratificaciones_sueldos: 0, bonif_extraordinaria_pct: 0,
  cts_sueldos_anio: 0, vacaciones_dias: 15,
};
const PEQUENA: RegimenLaboral = {
  regimen: "pequena_empresa", nombre: "Pequeña empresa",
  essalud_pct: 0.09, usa_sis: false, sis_aporte_mensual: 0,
  gratificaciones_sueldos: 1, bonif_extraordinaria_pct: 0.09,
  cts_sueldos_anio: 0.5, vacaciones_dias: 15,
};
const GENERAL: RegimenLaboral = {
  regimen: "general", nombre: "Régimen general",
  essalud_pct: 0.09, usa_sis: false, sis_aporte_mensual: 0,
  gratificaciones_sueldos: 2, bonif_extraordinaria_pct: 0.09,
  cts_sueldos_anio: 1.1667, vacaciones_dias: 30,
};

const BASE: DatosConductor = {
  tipo_contrato: "planilla", sueldo_basico: 1600, honorario_dia: null,
  tiene_asignacion: false, rmv: 1130, asignacion_familiar_pct: 0.10, sctr_mensual: 20,
};

let fallos = 0;
const ok = (cond: boolean, etq: string, det = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${etq}${det ? "  → " + det : ""}`);
  if (!cond) fallos++;
};
const cerca = (a: number, b: number, tol = 0.01) => Math.abs(a - b) < tol;

console.log("\n── Los tres regímenes dan factores distintos ──");
{
  const m = costoEmpresaMes(BASE, MICRO);
  const p = costoEmpresaMes(BASE, PEQUENA);
  const g = costoEmpresaMes(BASE, GENERAL);

  // Micro: solo el sueldo y el SCTR. Ni EsSalud (va al SIS), ni grati, ni CTS.
  ok(cerca(m.total, 1620), "microempresa · sueldo + SCTR", `S/ ${m.total.toFixed(2)}`);
  ok(m.gratificaciones === 0 && m.cts === 0, "microempresa · sin gratificaciones ni CTS");

  // Pequeña: 1600 + 144 EsSalud + 20 SCTR + 133.33 grati + 12 bonif + 66.67 CTS
  ok(cerca(p.total, 1976), "pequeña empresa · costo empresa", `S/ ${p.total.toFixed(2)}`);
  ok(cerca(p.factor, 1.235, 0.002), "pequeña empresa · factor sobre el básico", `${p.factor.toFixed(3)}×`);
  ok(cerca(p.gratificaciones, 133.33), "pequeña empresa · gratificación de 1 sueldo/año", `S/ ${p.gratificaciones.toFixed(2)}`);
  ok(cerca(p.cts, 66.67), "pequeña empresa · CTS de 15 remuneraciones diarias", `S/ ${p.cts.toFixed(2)}`);

  // General: 1600 + 144 + 20 + 266.67 + 24 + 155.56
  ok(cerca(g.total, 2210.23), "régimen general · costo empresa", `S/ ${g.total.toFixed(2)}`);
  ok(cerca(g.factor, 1.381, 0.002), "régimen general · factor sobre el básico", `${g.factor.toFixed(3)}×`);
  ok(g.total > p.total && p.total > m.total, "el orden micro < pequeña < general se mantiene");
}

console.log("\n── La asignación familiar entra en la BASE, no se suma al final ──");
{
  const sin = costoEmpresaMes(BASE, PEQUENA);
  const con = costoEmpresaMes({ ...BASE, tiene_asignacion: true }, PEQUENA);
  const asignacion = 113;  // 10 % de la RMV de 1,130
  ok(cerca(con.asignacionFamiliar, asignacion), "la asignación es el 10 % de la RMV", `S/ ${con.asignacionFamiliar.toFixed(2)}`);
  ok(cerca(con.remuneracionComputable, 1713), "entra en la remuneración computable", `S/ ${con.remuneracionComputable.toFixed(2)}`);
  // Si solo se sumara al final, la diferencia sería exactamente 113. Como también
  // sube EsSalud, la gratificación y la CTS, tiene que ser MÁS.
  ok(con.total - sin.total > asignacion,
     "arrastra EsSalud, gratificación y CTS: sube MÁS que su propio importe",
     `+S/ ${(con.total - sin.total).toFixed(2)} sobre S/ ${asignacion}`);
}

console.log("\n── El sueldo se prorratea, no se imputa entero ──");
{
  const c = costoConductorServicio(BASE, PEQUENA, { diasConServicio: 24, serviciosDelDia: 1, diasLaborablesMes: 26 });
  ok(cerca(c.porDia, 82.33), "24 días con servicio → costo por día", `S/ ${c.porDia.toFixed(2)}`);
  ok(c.porDia < 1976, "un servicio NO carga el mes entero", `S/ ${c.porDia.toFixed(2)} vs S/ 1,976`);

  const dos = costoConductorServicio(BASE, PEQUENA, { diasConServicio: 24, serviciosDelDia: 2, diasLaborablesMes: 26 });
  ok(cerca(dos.porServicio, c.porDia / 2), "dos servicios el mismo día se reparten el día", `S/ ${dos.porServicio.toFixed(2)} c/u`);
  ok(cerca(dos.porDia, c.porDia), "…y el costo del DÍA no cambia por eso");

  // Poca actividad encarece el día. No es un error: es la capacidad ociosa.
  const flojo = costoConductorServicio(BASE, PEQUENA, { diasConServicio: 8, serviciosDelDia: 1, diasLaborablesMes: 26 });
  ok(flojo.porDia > c.porDia * 2, "con 8 días de servicio el día cuesta mucho más", `S/ ${flojo.porDia.toFixed(2)}`);
  ok(cerca(flojo.porDiaLaborable, 76.0), "el contraste contra días laborables se publica aparte", `S/ ${flojo.porDiaLaborable.toFixed(2)}`);
}

console.log("\n── Honorarios: va completo, no se prorratea ──");
{
  const h: DatosConductor = { ...BASE, tipo_contrato: "honorarios", sueldo_basico: null, honorario_dia: 180 };
  const c = costoConductorServicio(h, PEQUENA, { diasConServicio: 3, serviciosDelDia: 1, diasLaborablesMes: 26 });
  ok(c.porDia === 180, "el importe del recibo es el costo del día", `S/ ${c.porDia.toFixed(2)}`);
  ok(c.costoMes === 0, "no hay costo mensual que prorratear");
  ok(!c.falta, "y no reclama el sueldo básico, que no aplica");

  const dos = costoConductorServicio(h, PEQUENA, { diasConServicio: 3, serviciosDelDia: 2, diasLaborablesMes: 26 });
  ok(dos.porServicio === 90, "si ese día cubrió dos servicios, también se reparte", `S/ ${dos.porServicio.toFixed(2)}`);
}

console.log("\n── Faltantes y divisores en cero ──");
{
  const sinSueldo = costoConductorServicio({ ...BASE, sueldo_basico: null }, PEQUENA,
    { diasConServicio: 20, serviciosDelDia: 1, diasLaborablesMes: 26 });
  ok(sinSueldo.porDia === 0 && !!sinSueldo.falta, "sin sueldo no inventa un costo, lo reclama", sinSueldo.falta ?? "");

  const sinHonorario = costoConductorServicio({ ...BASE, tipo_contrato: "honorarios", honorario_dia: null }, PEQUENA,
    { diasConServicio: 1, serviciosDelDia: 1, diasLaborablesMes: 26 });
  ok(!!sinHonorario.falta, "lo mismo con el honorario por día", sinHonorario.falta ?? "");

  const sinDias = costoConductorServicio(BASE, PEQUENA, { diasConServicio: 0, serviciosDelDia: 1, diasLaborablesMes: 26 });
  ok(Number.isFinite(sinDias.porDia) && sinDias.porDia > 0,
     "cero días con servicio NO produce Infinity: cae a días laborables", `S/ ${sinDias.porDia.toFixed(2)}`);
  ok(/laborables/.test(sinDias.base), "…y lo dice en la base del cálculo");

  const sinLaborables = costoConductorServicio(BASE, PEQUENA, { diasConServicio: 0, serviciosDelDia: 0, diasLaborablesMes: 0 });
  ok(Number.isFinite(sinLaborables.porServicio), "ni siquiera con todo en cero", String(sinLaborables.porServicio.toFixed(2)));
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
