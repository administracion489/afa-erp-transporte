// Pruebas del badge «Rastreo %» del resumen del viaje. NO tocan la base: módulo puro lib/huella.ts.
// Uso:  npx tsx scripts/prueba-cobertura-rastreo.mts   (sale con código 1 si algo falla)
//
// EL CASO REAL (reserva #6166, VFC-962, Compañía Hard Discount): el modal de /seguimiento decía
// «Rastreo 100%» con 0.4 km recorridos y 3 min de duración (salida 4:08, última señal 4:11) sobre
// una ruta prevista de 55 min, y la tarjeta de al lado decía «Todas las paradas cubiertas — el
// conductor marcó el recorrido completo». El GPS dejó de transmitir a los 400 m; el servicio siguió.
//
// LA CAUSA: el % era `medido / (medido + estimado)`, y el estimado solo rellena huecos ENTRE dos
// señales. Lo que pasa DESPUÉS de la última señal no entraba en ningún lado: 0.4 / 0.4 = 100 %.
//
// LO QUE FIJAN:
//   1. el algoritmo VIEJO (copiado literal) reproduce el 100 % del caso real — si deja de hacerlo,
//      el escenario dejó de ser el que se rompió;
//   2. con el servicio TERMINADO el % se mide contra la ruta prevista;
//   3. EL LADO QUE NO SE PUEDE AFLOJAR: con el servicio EN CURSO, o sin ruta prevista, el resultado
//      es IDÉNTICO al viejo. Medir contra la ruta entera a mitad de camino pintaría de rojo un
//      servicio sano;
//   4. un trayecto más largo que la ruta (desvío, ida a cochera) no baja de 100 % por eso.
import { coberturaRastreo, largoLineaM, distM } from "../lib/huella";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// La fórmula de antes, copiada literal de ModalGps.tsx / app/cliente/page.tsx.
const pctViejo = (medidoM: number, estimadoM: number, medidoPctResumen: number) =>
  medidoM + estimadoM > 0 ? Math.round((medidoM / (medidoM + estimadoM)) * 100) : medidoPctResumen;

// ── 1. El caso #6166 ─────────────────────────────────────────────────────────────
console.log("\n1. Reserva #6166: 0.4 km con señal, ruta prevista de ~23 km, todas las paradas cubiertas");
{
  const medidoM = 400, estimadoM = 0, rutaM = 23_000;
  chk("el algoritmo viejo daba 100 %", pctViejo(medidoM, estimadoM, 100) === 100);
  const c = coberturaRastreo({ medidoM, estimadoM, rutaPrevistaM: rutaM, servicioTerminado: true })!;
  chk("ahora se mide contra la ruta prevista", c.referencia === "ruta_prevista");
  chk("y da 2 %", c.pct === 2, `pct=${c.pct}`);
  chk("nombra los km sin huella", c.sinHuellaKm === 22.6, `sinHuellaKm=${c.sinHuellaKm}`);
  chk("publica lo medido aparte", c.medidoKm === 0.4 && c.referenciaKm === 23);
}

// ── 2. Servicio terminado con huella completa ─────────────────────────────────────
console.log("\n2. Servicio terminado con la huella completa");
{
  const c = coberturaRastreo({ medidoM: 22_800, estimadoM: 0, rutaPrevistaM: 23_000, servicioTerminado: true })!;
  chk("una huella casi igual a la ruta sigue en verde (≥ 90 %)", c.pct >= 90, `pct=${c.pct}`);
  const largo = coberturaRastreo({ medidoM: 27_000, estimadoM: 0, rutaPrevistaM: 23_000, servicioTerminado: true })!;
  chk("trayecto MÁS largo que la ruta (desvío, cochera) = 100 %", largo.pct === 100 && largo.referencia === "trayecto");
  chk("y no inventa km sin huella", largo.sinHuellaKm === 0);
  const conHueco = coberturaRastreo({ medidoM: 18_000, estimadoM: 5_000, rutaPrevistaM: 23_000, servicioTerminado: true })!;
  chk("un túnel estimado sigue contando como no medido", conHueco.pct === 78, `pct=${conHueco.pct}`);
}

// ── 3. El lado que no se puede aflojar: en curso o sin ruta → idéntico al viejo ──
console.log("\n3. En curso, o sin ruta prevista: idéntico a la fórmula vieja (barrido)");
{
  let iguales = 0, total = 0;
  const metros = [0, 1, 50, 400, 2_000, 9_999, 23_000, 41_000];
  for (const medidoM of metros) for (const estimadoM of metros) for (const rutaM of [null, 0, 400, 23_000, 80_000]) {
    for (const terminado of [false, true]) {
      if (terminado && rutaM != null && rutaM > 0) continue;   // ese es el caso que SÍ cambia
      total++;
      const c = coberturaRastreo({ medidoM, estimadoM, rutaPrevistaM: rutaM, servicioTerminado: terminado });
      const viejo = pctViejo(medidoM, estimadoM, 100);
      const nuevo = c ? c.pct : 100;   // sin línea: el modal cae al medidoPct del resumen (100)
      if (nuevo === viejo && (!c || c.referencia === "trayecto")) iguales++;
    }
  }
  chk(`${iguales}/${total} combinaciones idénticas`, iguales === total);
  const enCurso = coberturaRastreo({ medidoM: 400, estimadoM: 0, rutaPrevistaM: 23_000, servicioTerminado: false })!;
  chk("en curso a los 400 m NO se mide contra la ruta entera", enCurso.pct === 100 && enCurso.referencia === "trayecto");
}

// ── 4. Invariantes por barrido ────────────────────────────────────────────────────
console.log("\n4. Invariantes");
{
  let ok = true, cambia = 0;
  const ms = [0, 1, 37, 400, 1_500, 9_000, 23_000, 60_000];
  for (const medidoM of ms) for (const estimadoM of ms) for (const rutaM of [null, 0, 400, 23_000, 90_000]) for (const t of [false, true]) {
    const c = coberturaRastreo({ medidoM, estimadoM, rutaPrevistaM: rutaM, servicioTerminado: t });
    if (!c) { if (medidoM + estimadoM > 0 || (t && (rutaM ?? 0) > 0)) ok = false; continue; }
    if (c.pct < 0 || c.pct > 100) ok = false;
    // el nuevo nunca da MÁS que el viejo: solo puede dejar de exagerar
    if (medidoM + estimadoM > 0 && c.pct > pctViejo(medidoM, estimadoM, 100)) ok = false;
    // solo hay km sin huella cuando se midió contra la ruta
    if (c.sinHuellaKm > 0 && c.referencia !== "ruta_prevista") ok = false;
    if (c.pct < pctViejo(medidoM, estimadoM, 100)) cambia++;
  }
  chk("0 ≤ pct ≤ 100, nunca más que el viejo, km sin huella solo contra la ruta", ok);
  chk("corolario: sí baja el % en algún caso (no es un motor que no cambia nada)", cambia > 0, `${cambia} casos`);
}

// ── 5. largoLineaM ────────────────────────────────────────────────────────────────
console.log("\n5. Largo de la ruta prevista");
{
  const linea: [number, number][] = [[-77.05, -12.05], [-77.05, -12.04], [-77.04, -12.04]];
  const esperado = distM(-12.05, -77.05, -12.04, -77.05) + distM(-12.04, -77.05, -12.04, -77.04);
  chk("suma los tramos [lng, lat]", Math.abs(largoLineaM(linea) - esperado) < 0.01);
  chk("vacía o nula = 0", largoLineaM([]) === 0 && largoLineaM(null) === 0 && largoLineaM(undefined) === 0);
  chk("salta coordenadas rotas sin NaN", Number.isFinite(largoLineaM([[-77, -12], [NaN, -12], [-77, -12.01]])));
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
