// Pruebas del PRÓXIMO SERVICIO preventivo (lib/mantenimiento/proximo-servicio.ts).
// NO tocan la base. Uso:  npx tsx scripts/prueba-proximo-servicio.mts   (exit 1 si algo falla)
//
// EL CASO (CWZ-371, 05/10/2026): una lectura de odómetro equivocada hizo que el cron abriera la
// OT #6 «servicio de los 20 000 km». Se cerró y el cierre dejó en el libro un preventivo a 19 484.
// La unidad va por 19 725 y el servicio de los 20 000 no se hizo, pero «Próximo km» decía 29 484:
// reabrir, cancelar o eliminar la OT dejaba su fila del libro, que es el ancla del cálculo.

import {
  esServicioHecho, ultimoServicioPorVehiculo, proximoPorKm, planAlSalirDeCierre, porQueNoAncla, otsMencionadas,
  type FilaLibro, type EstadosOT,
} from "../lib/mantenimiento/proximo-servicio";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── El algoritmo VIEJO, copiado literal (ProgramaTab y el cron tenían esta misma copia) ──
function viejo(mants: FilaLibro[], vehiculoId: number, kmActual: number, interKm: number | null) {
  const ultMant: Record<number, FilaLibro> = {};
  for (const m of mants) if (!ultMant[m.vehiculo_id]) ultMant[m.vehiculo_id] = m; // ya vienen por fecha desc
  const um = ultMant[vehiculoId];
  let dueKm: number | null = null;
  const inter = Number(interKm || 0);
  if (inter > 0) {
    const ultServ = um?.kilometraje ?? null;
    dueKm = ultServ !== null ? Number(ultServ) + inter : (Math.floor(kmActual / inter) + 1) * inter;
  }
  return dueKm;
}
function nuevo(mants: FilaLibro[], vehiculoId: number, kmActual: number, interKm: number | null) {
  const um = ultimoServicioPorVehiculo(mants)[vehiculoId];
  return proximoPorKm({ kmActual, intervaloKm: interKm, ultimoServicioKm: um?.kilometraje ?? null })?.dueKm ?? null;
}

const ot6: FilaLibro = { vehiculo_id: 7, fecha: "2026-09-14", kilometraje: 19484, tipo: "preventivo", estado: "finalizado" };

console.log("\n1 · El caso CWZ-371");
{
  chk("REGRESIÓN: con la fila de la OT #6 en el libro, el viejo dice 29 484", viejo([ot6], 7, 19725, 10000) === 29484);
  chk("…y el nuevo también (la fila está, el servicio cuenta)", nuevo([ot6], 7, 19725, 10000) === 29484);

  const plan = planAlSalirDeCierre({ estado: "cerrada", mantenimiento_id: 55 }, "cancelada");
  chk("cancelar la OT RETIRA su servicio del libro", plan.accion === "retirar" && plan.accion === "retirar" && (plan as any).mantenimientoId === 55);
  chk("sin esa fila, el próximo vuelve a la rejilla: 20 000", nuevo([], 7, 19725, 10000) === 20000);

  const cancelada = { ...ot6, estado: "cancelado" };
  chk("REGRESIÓN: una fila CANCELADA en el libro el viejo la sigue contando", viejo([cancelada], 7, 19725, 10000) === 29484);
  chk("el nuevo NO la cuenta: 20 000", nuevo([cancelada], 7, 19725, 10000) === 20000);

  const anterior: FilaLibro = { vehiculo_id: 7, fecha: "2026-05-02", kilometraje: 9950, tipo: "preventivo", estado: "finalizado" };
  chk("cancelada la última, ancla el servicio HECHO anterior", nuevo([cancelada, anterior], 7, 19725, 10000) === 19950);
}

console.log("\n2 · Qué hacer con el libro cuando la OT deja de estar cerrada");
{
  const c = { estado: "cerrada", mantenimiento_id: 9 };
  chk("sigue cerrada → nada", planAlSalirDeCierre(c, "cerrada").accion === "nada");
  chk("reabierta → retirar", planAlSalirDeCierre(c, "abierta").accion === "retirar");
  chk("en proceso → retirar", planAlSalirDeCierre(c, "en_proceso").accion === "retirar");
  chk("eliminada → retirar", planAlSalirDeCierre(c, "eliminada").accion === "retirar");
  const sinAncla = planAlSalirDeCierre({ estado: "cerrada", mantenimiento_id: null }, "cancelada");
  chk("cerrada SIN ancla → no se adivina qué fila borrar (se nombra)", sinAncla.accion === "nada" && (sinAncla as any).motivo === "sin_ancla");
  chk("abierta que nunca cerró → nada", planAlSalirDeCierre({ estado: "abierta", mantenimiento_id: null }, "cancelada").accion === "nada");
  // La OT que se reabrió con el código viejo: ya no está cerrada pero su fila sigue anclada.
  chk("ya no cerrada pero todavía anclada → retirar", planAlSalirDeCierre({ estado: "cancelada", mantenimiento_id: 9 }, "cancelada").accion === "retirar");
}

console.log("\n3 · Qué cuenta como servicio hecho");
{
  chk("preventivo finalizado", esServicioHecho(ot6));
  chk("sin estado (filas viejas) cuenta", esServicioHecho({ ...ot6, estado: null }));
  chk("cancelado no", !esServicioHecho({ ...ot6, estado: "cancelado" }));
  chk("correctivo no ancla el preventivo", !esServicioHecho({ ...ot6, tipo: "correctivo" }));
  const mismoDia = ultimoServicioPorVehiculo([
    { vehiculo_id: 1, fecha: "2026-09-01", kilometraje: 5000, tipo: "preventivo" },
    { vehiculo_id: 1, fecha: "2026-09-01", kilometraje: 5200, tipo: "preventivo" },
  ])[1];
  chk("dos el mismo día: gana el de más km", mismoDia.kilometraje === 5200);
}

console.log("\n4 · La OT se ELIMINÓ antes del arreglo: su fila se quedó huérfana en el libro");
{
  // Lo que quedó en producción: OT #6 eliminada, su fila editada a mano a 20 000 km y «Pendiente».
  const huerfana: FilaLibro = { vehiculo_id: 7, fecha: "2026-10-02", kilometraje: 20000, tipo: "preventivo", estado: "pendiente", descripcion: "OT #6 — CWZ-371" };
  const ot3: FilaLibro = { vehiculo_id: 7, fecha: "2026-08-20", kilometraje: 15000, tipo: "preventivo", estado: "finalizado", descripcion: "OT #3 — CWZ-371" };
  const estados: EstadosOT = new Map([[3, "cerrada"], [4, "cerrada"], [5, "abierta"]]); // la #6 no existe
  const hoy = "2026-10-06";
  const due = (filas: FilaLibro[], estadoOT: EstadosOT | null) =>
    proximoPorKm({ kmActual: 19725, intervaloKm: 5000, ultimoServicioKm: ultimoServicioPorVehiculo(filas, { estadoOT, hoy })[7]?.kilometraje })?.dueKm;

  chk("REGRESIÓN: sin mirar las OT, la huérfana ancla → 25 000", due([huerfana, ot3], null) === 25000);
  chk("mirando las OT, la huérfana no ancla → 20 000 (la OT #3 manda)", due([huerfana, ot3], estados) === 20000);
  chk("su motivo es ot_eliminada", porQueNoAncla(huerfana, { estadoOT: estados }) === "ot_eliminada");
  chk("una fila de OT cerrada sigue anclando", porQueNoAncla(ot3, { estadoOT: estados, hoy }) === null);
  chk("una fila de OT abierta (reabierta con el código viejo) no ancla",
    porQueNoAncla({ ...ot3, descripcion: "OT #5 — CWZ-371" }, { estadoOT: estados }) === "ot_no_cerrada");
  chk("una fila SIN «OT #» (servicio cargado a mano) no se juzga por OT",
    porQueNoAncla({ ...ot3, descripcion: "Cambio de aceite taller Pérez" }, { estadoOT: estados, hoy }) === null);
  chk("consulta de OT fallida (null) → no se juzga: nada se vuelve huérfano",
    porQueNoAncla(huerfana, { estadoOT: null }) === null);
  chk("otsMencionadas lee los ids sin repetir", JSON.stringify(otsMencionadas([huerfana, ot3, ot3]).sort()) === "[3,6]");
}

console.log("\n5 · Lo que todavía no pasó no ancla");
{
  const prog: FilaLibro = { vehiculo_id: 2, fecha: "2026-11-01", kilometraje: 30000, tipo: "preventivo", estado: "pendiente" };
  const hecho: FilaLibro = { vehiculo_id: 2, fecha: "2026-09-01", kilometraje: 25000, tipo: "preventivo", estado: "finalizado" };
  chk("fecha futura → futuro", porQueNoAncla(prog, { hoy: "2026-10-06" }) === "futuro");
  chk("hoy mismo sí cuenta", porQueNoAncla({ ...prog, fecha: "2026-10-06" }, { hoy: "2026-10-06" }) === null);
  chk("con un programado futuro, ancla el hecho anterior",
    ultimoServicioPorVehiculo([prog, hecho], { hoy: "2026-10-06" })[2]?.kilometraje === 25000);
  chk("sin `hoy` el comportamiento es el de antes", ultimoServicioPorVehiculo([prog, hecho])[2]?.kilometraje === 30000);
}

console.log("\n6 · Barrido: sin filas canceladas, el nuevo dice lo mismo que el viejo");
{
  let combos = 0, distintos = 0;
  const fechas = ["2026-01-10", "2026-04-20", "2026-08-05"];
  for (const inter of [null, 0, 5000, 10000])
    for (const kmActual of [0, 4999, 5000, 7217, 19725, 20000, 150321])
      for (let mask = 0; mask < 8; mask++) {
        const mants: FilaLibro[] = fechas
          .map((f, i) => ({ vehiculo_id: 3, fecha: f, kilometraje: 1000 + i * 4800, tipo: "preventivo", estado: "finalizado" }))
          .filter((_, i) => mask & (1 << i))
          .sort((a, b) => (a.fecha! < b.fecha! ? 1 : -1)); // como llega de la base: fecha desc
        combos++;
        if (viejo(mants, 3, kmActual, inter) !== nuevo(mants, 3, kmActual, inter)) distintos++;
      }
  chk(`${combos} combinaciones idénticas al algoritmo viejo`, distintos === 0, `${distintos} distintas`);
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
