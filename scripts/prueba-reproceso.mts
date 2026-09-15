// Pruebas de QUÉ SE RETIRA Y QUÉ ES INTOCABLE al reprocesar un mensaje del Radar. NO tocan la
// base: datos en memoria contra el módulo puro lib/radar/reproceso.ts.
// Uso:  npx tsx scripts/prueba-reproceso.mts   (sale con código 1 si algo falla)
//
// El botón "Reprocesar" vuelve a correr el pipeline ENTERO, acción incluida, y las acciones
// insertan sin mirar si la corrida anterior ya lo hizo: cada clic duplicaba `radar_combustible`,
// `radar_oportunidades`, `radar_alertas` y —con el auto-registro activo— `combustible` (el
// gasto real) y `mantenimiento` (la orden de trabajo). Con dos vouchers en una ráfaga, un
// reproceso dejaba cuatro filas para dos recargas.
//
// La línea que estas pruebas defienden es una sola, y la mitad de los casos existen para
// probar el lado que NO se puede aflojar:
//
//     LO PROPUESTO SE RETIRA; LO COMPROMETIDO NO SE TOCA NI SE REPITE.
//
// Una fila borrada de más en `radar_combustible` es una propuesta que se vuelve a calcular.
// Una carga borrada de más en `combustible` es plata que desaparece de v_egresos, del costo
// por km y del margen del servicio — y nadie se entera.
import { planificarReproceso, type ArtefactoPrevio } from "../lib/radar/reproceso";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── 1. Sin nada previo (primera corrida): no hay nada que retirar ───────────
{
  const p = planificarReproceso([]);
  chk("una primera corrida no retira nada", p.totalRetirar === 0);
  chk("ni bloquea ningún registro", p.combustibleId === null && p.ordenMantenimientoId === null);
  chk("y no tiene nada que decir", p.detalle === "");
}

// ── 2. El caso del usuario: propuestas por revisar se reemplazan ────────────
{
  const previos: ArtefactoPrevio[] = [
    { tabla: "radar_combustible", id: "rc1", estado: "pendiente_revision", comprometido: null },
    { tabla: "radar_combustible", id: "rc2", estado: "pendiente_revision", comprometido: null },
    { tabla: "radar_alertas", id: "al1" },
  ];
  const p = planificarReproceso(previos);
  chk("las dos propuestas se retiran", p.retirar.radar_combustible.length === 2, p.retirar.radar_combustible.join(","));
  chk("la alerta también", p.retirar.radar_alertas.length === 1);
  chk("no hay carga comprometida", p.combustibleId === null);
  console.log(`        ${p.detalle}`);
}

// ── 3. LO COMPROMETIDO NO SE TOCA: una carga ya registrada ─────────────────
{
  const previos: ArtefactoPrevio[] = [
    { tabla: "radar_combustible", id: "rc1", estado: "registrado", comprometido: 4821 },
  ];
  const p = planificarReproceso(previos);
  chk("la fila registrada NO entra a la lista de retiro", p.retirar.radar_combustible.length === 0);
  chk("y se recuerda qué carga creó", p.combustibleId === 4821, String(p.combustibleId));
  chk("el detalle dice dónde está y qué hacer", p.detalle.includes("#4821") && p.detalle.includes("bórrala primero"));
  console.log(`        ${p.detalle}`);
}
{
  // Filas viejas: puede faltar el estado o el FK. Con cualquiera de los dos, se conserva.
  const soloEstado = planificarReproceso([{ tabla: "radar_combustible", id: "a", estado: "registrado" }]);
  chk("con estado 'registrado' y sin FK, se conserva igual", soloEstado.retirar.radar_combustible.length === 0);
  const soloFk = planificarReproceso([{ tabla: "radar_combustible", id: "b", estado: null, comprometido: 99 }]);
  chk("con FK y sin estado, también", soloFk.retirar.radar_combustible.length === 0 && soloFk.combustibleId === 99);
}

// ── 4. Mezcla: se retira la propuesta y se conserva la comprometida ────────
{
  const previos: ArtefactoPrevio[] = [
    { tabla: "radar_combustible", id: "viva", estado: "registrado", comprometido: 500 },
    { tabla: "radar_combustible", id: "propuesta", estado: "pendiente_revision" },
  ];
  const p = planificarReproceso(previos);
  chk("solo se retira la propuesta", p.retirar.radar_combustible.join() === "propuesta", p.retirar.radar_combustible.join());
  chk("y la comprometida marca el bloqueo", p.combustibleId === 500);
}

// ── 5. Una descartada por un humano sí se retira (el reproceso es explícito) ─
{
  const p = planificarReproceso([{ tabla: "radar_combustible", id: "d1", estado: "descartado" }]);
  chk("la descartada se retira y se vuelve a evaluar", p.retirar.radar_combustible.join() === "d1");
}

// ── 6. Oportunidades: solo la intacta se retira ────────────────────────────
{
  const previos: ArtefactoPrevio[] = [
    { tabla: "radar_oportunidades", id: "o1", estado: "nueva" },
    { tabla: "radar_oportunidades", id: "o2", estado: "cotizada", comprometido: 77 },
    { tabla: "radar_oportunidades", id: "o3", estado: "revisada" },
    { tabla: "radar_oportunidades", id: "o4", estado: "descartada" },
  ];
  const p = planificarReproceso(previos);
  chk("solo la 'nueva' se retira", p.retirar.radar_oportunidades.join() === "o1", p.retirar.radar_oportunidades.join());
  chk("y se avisa que alguien ya trabajó una", p.oportunidadTocada);
  chk("el detalle lo dice", p.detalle.includes("ya fue trabajada"));
}
{
  // Una 'nueva' que ya cuelga de una cotización: el estado miente, el FK manda.
  const p = planificarReproceso([{ tabla: "radar_oportunidades", id: "o", estado: "nueva", comprometido: 12 }]);
  chk("con cotización detrás no se retira aunque diga 'nueva'", p.retirar.radar_oportunidades.length === 0);
  chk("y cuenta como tocada", p.oportunidadTocada);
}

// ── 7. Los registros REALES sin columna al mensaje salen del resultado ─────
{
  // `combustible` y `mantenimiento` no tienen `mensaje_id`: el único rastro es lo que la
  // corrida anterior guardó en radar_mensajes.resultado, que el reproceso no borra.
  const p = planificarReproceso([], { accion: { datos: { orden_id: 91, combustible_id: 12 } } });
  chk("la orden de mantenimiento previa se recuerda", p.ordenMantenimientoId === 91, String(p.ordenMantenimientoId));
  chk("y la carga previa también", p.combustibleId === 12, String(p.combustibleId));
  chk("el detalle nombra la orden", p.detalle.includes("#91"));
}
{
  // La fila del Radar manda sobre el blob cuando las dos traen id.
  const p = planificarReproceso(
    [{ tabla: "radar_combustible", id: "x", estado: "registrado", comprometido: 4821 }],
    { accion: { datos: { combustible_id: 999 } } }
  );
  chk("el FK de la fila gana sobre el resultado guardado", p.combustibleId === 4821, String(p.combustibleId));
}
{
  const p = planificarReproceso([], { accion: { datos: {} } });
  chk("un resultado sin ids no bloquea nada", p.combustibleId === null && p.ordenMantenimientoId === null);
  const p2 = planificarReproceso([], null);
  chk("un resultado nulo tampoco", p2.combustibleId === null && p2.ordenMantenimientoId === null);
  const p3 = planificarReproceso([], "texto raro");
  chk("ni uno con forma inesperada", p3.combustibleId === null && p3.ordenMantenimientoId === null);
}

// ── 8. Basura en la lista no rompe ni borra de más ─────────────────────────
{
  const p = planificarReproceso([
    { tabla: "radar_combustible", id: "" },
    null as unknown as ArtefactoPrevio,
    { tabla: "radar_alertas", id: "ok" },
  ]);
  chk("las filas sin id se ignoran", p.retirar.radar_combustible.length === 0);
  chk("y la buena entra igual", p.retirar.radar_alertas.join() === "ok");
}

// ── 9. Un cero como FK es 'sin registro', no un id ─────────────────────────
{
  const p = planificarReproceso([{ tabla: "radar_combustible", id: "z", estado: "pendiente_revision", comprometido: 0 }]);
  chk("comprometido=0 no cuenta como registro", p.combustibleId === null && p.retirar.radar_combustible.join() === "z");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
