// Pruebas de la PROPUESTA DE TANQUE LLENO del Radar (lib/radar/tanque-lleno.ts).
// NO tocan la base: datos en memoria. Uso: npx tsx scripts/prueba-tanque-lleno.mts
//
// Lo que fija esta matriz, y es una sola idea: **la aguja PROPONE, los indicios SUGIEREN y la
// casilla la decide una persona.** Un `tanque_lleno = false` puesto por una heurística deja de
// anclar ese tramo en silencio, y un tramo que deja de medirse no se nota en ninguna pantalla.
import { proponerTanqueLleno, importeEsRedondo, FRACCION_TANQUE_LLENO, juzgarNivelTanque } from "../lib/radar/tanque-lleno";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const bus = { categoria: "BUS", capacidad_tanque: { diesel: 100 } };
const tieneIndicio = (p: ReturnType<typeof proponerTanqueLleno>, cod: string) =>
  p.indicios.some((i) => i.codigo === cod);

// ── 1. EL IMPORTE REDONDO ───────────────────────────────────────────────────
//
// Un voucher imprime `cantidad × precio`, y ese producto casi nunca cae redondo por azar:
// 8.799 × 24.640 = 216.81. Un S/ 100.00 exacto significa que se despachó HASTA UN MONTO, que
// es literalmente el caso «no había saldo de crédito» que nombró el dueño.
{
  chk("S/ 100.00 es redondo", importeEsRedondo(100));
  chk("S/ 150.00 también", importeEsRedondo(150));
  chk("S/ 30.00 también (en Perú se carga «treinta soles»)", importeEsRedondo(30));
  chk("S/ 216.81 NO lo es", !importeEsRedondo(216.81));
  chk("S/ 240.56 NO lo es", !importeEsRedondo(240.56));
  // El múltiplo de 10 evita el falso positivo del producto que cae en céntimos exactos.
  chk("S/ 172.00 NO lo es: céntimos exactos por casualidad, no carga por monto", !importeEsRedondo(172));
  chk("sin importe no se afirma nada", !importeEsRedondo(null) && !importeEsRedondo(0));
}

// ── 2. LA AGUJA ES LO ÚNICO QUE MUEVE EL DEFAULT ────────────────────────────
{
  const sinNada = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 30, unidad: "galones", monto: 216.81 });
  chk("sin aguja el default es la POLÍTICA (null → la pantalla marca la casilla)",
    sinNada.porDefecto === null && sinNada.fuente === null);
  chk("…y sin indicios no se dice nada", sinNada.indicios.length === 0);

  const lleno = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 30, unidad: "galones", monto: 216.81, nivelAguja: "lleno" });
  chk("la aguja en LLENO propone true y se declara `ia_aguja`",
    lleno.porDefecto === true && lleno.fuente === "ia_aguja");

  const parcial = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 30, unidad: "galones", monto: 216.81, nivelAguja: "parcial" });
  chk("la aguja PARCIAL propone false", parcial.porDefecto === false && parcial.fuente === "ia_aguja");

  const noVisible = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 30, unidad: "galones", nivelAguja: "no_visible" });
  chk("«no_visible» NO afirma nada: tri-estado, no se concluye por ausencia de evidencia",
    noVisible.porDefecto === null && noVisible.fuente === null && !tieneIndicio(noVisible, "aguja"));
}

// ── 3. LO QUE NO SE PUEDE AFLOJAR: UNA HEURÍSTICA NO DESANCLA UN TRAMO ──────
//
// Es la mitad que importa. Si el importe redondo moviera la casilla, el Radar estaría marcando
// como parciales cargas que quizá sí llenaron el tanque, y esos tramos dejarían de medirse sin
// que nadie lo pida ni lo vea.
{
  const redondo = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 4, unidad: "galones", monto: 100 });
  chk("un importe redondo NO mueve el default", redondo.porDefecto === null && redondo.fuente === null);
  chk("…pero SÍ se dice, para que el revisor mire", tieneIndicio(redondo, "importe_redondo"));
  chk("…y el indicio declara hacia dónde apunta",
    redondo.indicios.find((i) => i.codigo === "importe_redondo")?.apunta === false);

  // Y con la aguja puesta, el indicio no la contradice: el default sigue siendo el de la aguja.
  const conAguja = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 4, unidad: "galones", monto: 100, nivelAguja: "lleno" });
  chk("con aguja LLENA y monto redondo manda la aguja, y los dos se enseñan",
    conAguja.porDefecto === true && conAguja.indicios.length === 2);
}

// ── 4. LA CANTIDAD CONTRA EL TANQUE: SOLO CONFIRMA, NUNCA NIEGA ─────────────
{
  const casiLleno = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 90, unidad: "galones" });
  chk("90 gal en un tanque de 100 confirman que quedó lleno", tieneIndicio(casiLleno, "cantidad_llena_el_tanque"));
  chk("…y el indicio apunta a true",
    casiLleno.indicios.find((i) => i.codigo === "cantidad_llena_el_tanque")?.apunta === true);

  // EL FALSO POSITIVO QUE SE EVITA: una flota que reposta a diario carga poco y queda llena.
  const poco = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 20, unidad: "galones" });
  chk("20 gal en un tanque de 100 NO son indicio de nada (el depósito venía medio lleno)",
    poco.indicios.length === 0);
  chk("la frontera está donde dice la constante, no en un número suelto",
    tieneIndicio(proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 100 * FRACCION_TANQUE_LLENO, unidad: "galones" }), "cantidad_llena_el_tanque"));

  // La cantidad se normaliza a la unidad del tanque: 340 litros ≈ 90 gal.
  const enLitros = proponerTanqueLleno({ vehiculo: bus, tipo: "diesel", cantidad: 340, unidad: "litros" });
  chk("340 litros se comparan como ~90 gal, no como 340", tieneIndicio(enLitros, "cantidad_llena_el_tanque"));

  chk("sin vehículo no se inventa una capacidad",
    proponerTanqueLleno({ tipo: "diesel", cantidad: 90, unidad: "galones" }).indicios.length === 0);
}

// ── 5. EL GNV, QUE ES EL 70 % DE LA FLOTA ───────────────────────────────────
{
  const gnv = { categoria: "BUS", capacidad_tanque: { gnv: 150 } };
  const p = proponerTanqueLleno({ vehiculo: gnv, tipo: "gnv", cantidad: 140, unidad: "m3" });
  chk("un tanque de GNV se juzga en m³, no en galones", tieneIndicio(p, "cantidad_llena_el_tanque"));
  // Y con la unidad mal escrita (lo que hacía el Radar antes de `unidadDeCarga`) no se afirma.
  const mal = proponerTanqueLleno({ vehiculo: gnv, tipo: "gnv", cantidad: 140, unidad: "galones" });
  chk("con la unidad rotulada mal no se puede convertir y NO se afirma nada", mal.indicios.length === 0);
}

// ── 6. ¿LE CREEMOS AL «PARCIAL»? (CNQ-396, 14/10/2026) ──────────────────────
//
// Tablero digital de una van con el tanque LLENO, y la IA dijo «parcial» sin decir qué indicador
// leyó: en ese tablero hay un tacómetro 0-1-2 con forma de reloj. Cada modelo pinta el nivel
// distinto; un «parcial» solo vale con el indicador nombrado y lo que se vio.
{
  // El caso real: como llegó (sin indicador ni evidencia) → se descarta.
  const real = juzgarNivelTanque({ nivel: "parcial", cantidad: 12.49, capacidad: 20 });
  chk("6a CNQ-396: «parcial» sin indicador se descarta → no_visible", real.nivel === "no_visible" && real.descartado === "sin_indicador");
  chk("6b «otro» tampoco identifica el del combustible",
    juzgarNivelTanque({ nivel: "parcial", indicador: "otro", evidencia: "un reloj a la derecha" }).descartado === "sin_indicador");
  chk("6c sin decir qué vio se descarta",
    juzgarNivelTanque({ nivel: "parcial", indicador: "barras", evidencia: "" }).descartado === "sin_evidencia");
  chk("6d la autonomía en km sola no prueba que no se llenó",
    juzgarNivelTanque({ nivel: "parcial", indicador: "autonomia", evidencia: "autonomía 180 km" }).descartado === "solo_autonomia");
  // Lo legítimo sigue pasando: barras con el surtidor a media altura, de cualquier modelo.
  for (const ind of ["aguja", "barras", "porcentaje"]) {
    const j = juzgarNivelTanque({ nivel: "parcial", indicador: ind, evidencia: "ícono de surtidor, 4 de 8 barras", cantidad: 5, capacidad: 20 });
    chk(`6e un parcial con evidencia (${ind}) SE CREE`, j.nivel === "parcial" && j.descartado === null);
  }
  chk("6f si se despachó casi el tanque entero, el «parcial» se descarta",
    juzgarNivelTanque({ nivel: "parcial", indicador: "aguja", evidencia: "aguja en 3/4 con E/F", cantidad: 18, capacidad: 20 }).descartado === "cantidad_llena");
  chk("6g sin capacidad conocida no se descarta por cantidad",
    juzgarNivelTanque({ nivel: "parcial", indicador: "aguja", evidencia: "aguja en 3/4 con E/F", cantidad: 18, capacidad: null }).nivel === "parcial");
  // «lleno» y «no_visible» no se tocan: anclan igual que la política.
  chk("6h «lleno» pasa tal cual aunque no diga el indicador", juzgarNivelTanque({ nivel: "lleno" }).nivel === "lleno");
  chk("6i «no_visible» pasa tal cual", juzgarNivelTanque({ nivel: "no_visible" }).nivel === "no_visible");
  chk("6j un valor raro no se inventa", juzgarNivelTanque({ nivel: "medio" }).nivel === null);
  // Barrido: nada que no sea «parcial» cambia; un «parcial» solo sobrevive con indicador válido
  // (no otro ni autonomía), evidencia y sin cantidad que llene el tanque.
  let n = 0, sobreviven = 0;
  for (const nivel of ["lleno", "parcial", "no_visible", null, "x"])
    for (const indicador of ["aguja", "barras", "porcentaje", "autonomia", "otro", null, "AGUJA"])
      for (const evidencia of [null, "", "corto", "ícono de surtidor, 2 barras"])
        for (const [cantidad, capacidad] of [[5, 20], [18, 20], [5, null], [null, 20]] as const) {
          n++;
          const j = juzgarNivelTanque({ nivel, indicador, evidencia, cantidad, capacidad });
          if (nivel !== "parcial") {
            if (j.descartado !== null) chk(`6k no-parcial intacto ${nivel}`, false);
            continue;
          }
          const ind = String(indicador ?? "").toLowerCase();
          const debe = ["aguja", "barras", "porcentaje"].includes(ind) && String(evidencia ?? "").length >= 8
            && !(cantidad != null && capacidad != null && cantidad >= capacidad * FRACCION_TANQUE_LLENO);
          if ((j.nivel === "parcial") !== debe) chk(`6k barrido ${nivel}/${indicador}/${evidencia}/${cantidad}/${capacidad}`, false);
          if (j.nivel === "parcial") sobreviven++;
        }
  chk(`6k barrido de ${n} combinaciones coherente`, true);
  chk("6l corolario: el barrido sí deja pasar parciales", sobreviven > 0);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
