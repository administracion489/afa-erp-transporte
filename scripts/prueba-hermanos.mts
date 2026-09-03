// Pruebas del ENLACE IDA↔RETORNO en la liquidación. NO tocan la base: son datos en
// memoria contra los módulos puros.
// Uso:  npx tsx scripts/prueba-hermanos.mts   (sale con código 1 si algo falla)
//
// Lo que garantizan, y que es exactamente lo que se rompió en producción: que un tramo en
// S/ 0.00 NUNCA salga del cierre pidiendo un precio cuando su día ya lo cobra el otro
// tramo. Ese "Sin precio de venta" falso es el error más caro del módulo — cargarle la
// tarifa factura el día dos veces— y aparecía en cuatro situaciones distintas:
//
//   · el enlace `reserva_vinculada_id` escrito en UN SOLO LADO (se escribe en dos pasos);
//   · el mismo caso pero con el retorno delante de su ida en el orden de proceso;
//   · sin enlace por ningún lado, con el par deducible sin ambigüedad;
//   · el hermano fuera del cierre (ya liquidado en otro documento).
//
// Y la contraparte, igual de importante: cuando NO se puede saber quién va con quién
// (dos móviles de la misma ruta el mismo día), no se empareja nada — un par inventado
// dejaría un día sin cobrar sin que nadie se entere.
import { analizarServicios, type ReservaLiq } from "../lib/liquidacion-agrupacion";
import { indiceHermanos } from "../lib/liquidacion-hermanos";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const ida = (id: number, over: Partial<ReservaLiq> = {}): ReservaLiq => ({
  id,
  codigo: `OS-2026-${String(id).padStart(6, "0")}`,
  fecha_servicio: "2026-08-14",
  hora_servicio: "05:10",
  estado: "finalizada",
  cliente_id: 1,
  ruta_nombre: "RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA",
  direccion_servicio: "ida",
  precio_cliente: 550,
  ...over,
});

const retorno = (id: number, over: Partial<ReservaLiq> = {}): ReservaLiq => ({
  id,
  codigo: `OS-2026-${String(id).padStart(6, "0")}`,
  fecha_servicio: "2026-08-14",
  hora_servicio: "17:00",
  estado: "finalizada",
  cliente_id: 1,
  ruta_nombre: "RUTA B/ RETORNO 17:00/ BSF PUNTA HERMOSA→CHILCA",
  direccion_servicio: "retorno",
  precio_cliente: 0,
  ...over,
});

/** Los motivos por los que quedó bloqueada una reserva, si quedó. */
const motivosDe = (a: ReturnType<typeof analizarServicios>, id: number) =>
  a.bloqueadas.find((b) => b.r.id === id)?.codigos ?? [];

// ── 1. El caso normal: enlace escrito en los dos lados ──────────────────────
{
  const rs = [ida(8032, { reserva_vinculada_id: 8400 }), retorno(8400, { reserva_vinculada_id: 8032 })];
  const a = analizarServicios(rs, "cliente");
  chk("enlace completo → un solo servicio facturable", a.pares.length === 1);
  chk("y nadie queda bloqueado", a.bloqueadas.length === 0);
  chk("el importe del día es el de la ida", a.pares[0]?.cabeza.id === 8032);
  chk("sin avisos de enlace roto", a.avisos.length === 0);
}

// ── 2. Enlace escrito SOLO en la ida (el paso 3 del generador no llegó) ─────
{
  const rs = [ida(8032, { reserva_vinculada_id: 8400 }), retorno(8400, { reserva_vinculada_id: null })];
  const a = analizarServicios(rs, "cliente");
  chk("enlace a medias (lo lleva la ida) → sigue siendo UN servicio", a.pares.length === 1);
  chk("el retorno NO sale como «Sin precio de venta»", !motivosDe(a, 8400).includes("sin_precio"),
    motivosDe(a, 8400).join(",") || "sin bloqueos");
  chk("y el par cubre los dos tramos", a.pares[0]?.sentido === "IDA Y RETORNO");
  chk("pero se AVISA de que el dato está a medias",
    a.avisos.some((x) => x.r.id === 8400 && /un solo lado/.test(x.mensaje)));
}

// ── 3. Enlace escrito SOLO en el retorno, y el retorno procesado primero ────
//
// El orden importa: el bucle marca como usadas las filas que va emparejando, así que si
// el tramo sin enlace se procesa antes que su hermano, el emparejamiento tiene que salir
// igual. Antes no salía: el primero quedaba bloqueado y el segundo se quedaba solo.
{
  const rs = [retorno(8400, { reserva_vinculada_id: 8032 }), ida(8032, { reserva_vinculada_id: null })];
  const a = analizarServicios(rs, "cliente");
  chk("enlace a medias (lo lleva el retorno) → un servicio", a.pares.length === 1);
  chk("la cabeza sigue siendo la que lleva la tarifa", a.pares[0]?.cabeza.id === 8032);
  chk("nadie bloqueado", a.bloqueadas.length === 0);
}

// ── 4. Sin enlace por ningún lado, pero el par se deduce ────────────────────
{
  const rs = [ida(8032), retorno(8400)];
  const idx = indiceHermanos(rs);
  chk("se deduce el par que perdió el enlace", idx.hermanoProbableDe(rs[1])?.id === 8032);
  chk("y es simétrico", idx.hermanoProbableDe(rs[0])?.id === 8400);
  chk("queda listado como reparable", idx.reparables.length === 1);
  chk("con la procedencia dicha", idx.reparables[0]?.procedencia === "deducido");

  const a = analizarServicios(rs, "cliente", {
    hermanoDe: idx.hermanoDe, hermanoProbableDe: idx.hermanoProbableDe,
  });
  chk("el retorno NO pide precio: pide el ENLACE", motivosDe(a, 8400).includes("falta_enlace"),
    motivosDe(a, 8400).join(",") || "sin bloqueos");
  chk("y el motivo nombra a su ida",
    /OS-2026-008032/.test(a.bloqueadas.find((b) => b.r.id === 8400)?.motivos[0] ?? ""));
  chk("la ida sí se liquida sola mientras tanto", a.pares.some((p) => p.cabeza.id === 8032));
}

// ── 5. Dos móviles el mismo día: NO se deduce nada ──────────────────────────
//
// Con dos idas y dos retornos de la misma ruta el mismo día, cualquier emparejamiento
// sería inventado. Emparejar mal deja un día sin cobrar y otro cobrado por dos tramos.
{
  const rs = [
    ida(1, { hora_servicio: "05:10" }), ida(2, { hora_servicio: "05:10" }),
    retorno(3, { hora_servicio: "17:00" }), retorno(4, { hora_servicio: "17:00" }),
  ];
  const idx = indiceHermanos(rs);
  chk("con dos móviles no se deduce ningún par", idx.reparables.length === 0);
  const a = analizarServicios(rs, "cliente", {
    hermanoDe: idx.hermanoDe, hermanoProbableDe: idx.hermanoProbableDe,
  });
  chk("y los retornos sí reclaman el dato que falta",
    motivosDe(a, 3).includes("sin_precio") && motivosDe(a, 4).includes("sin_precio"));
}

// ── 6. La deducción no cruza cliente, día ni ruta ───────────────────────────
{
  const casos: [string, ReservaLiq[]][] = [
    ["otro cliente", [ida(1), retorno(2, { cliente_id: 9 })]],
    ["otro día", [ida(1), retorno(2, { fecha_servicio: "2026-08-15" })]],
    ["otra ruta", [ida(1), retorno(2, { ruta_nombre: "RUTA C/ RETORNO 17:00/ BSF→CHILCA" })]],
    ["mismo sentido", [ida(1), ida(2, { precio_cliente: 0 })]],
  ];
  for (const [nombre, rs] of casos)
    chk(`no se deduce con ${nombre}`, indiceHermanos(rs).reparables.length === 0);
}

// ── 7. El hermano quedó FUERA del cierre (ya liquidado) ─────────────────────
//
// La ida entró en la liquidación del mes pasado y el retorno no. `entraAlCierre` deja la
// ida fuera del grupo, así que el retorno se queda solo — y lo que NO puede hacer el
// cierre es pedirle una tarifa: su día ya está facturado.
{
  const laIda = ida(8032, { reserva_vinculada_id: 8400, liquidacion_cliente_id: 77 });
  const elRetorno = retorno(8400, { reserva_vinculada_id: 8032 });
  const idx = indiceHermanos([laIda, elRetorno]);        // el periodo entero
  const a = analizarServicios([elRetorno], "cliente", {  // el grupo, ya filtrado
    hermanoDe: idx.hermanoDe, hermanoProbableDe: idx.hermanoProbableDe,
  });
  chk("no pide precio para un día ya cobrado", !motivosDe(a, 8400).includes("sin_precio"));
  chk("dice que su tarifa está fuera del cierre", motivosDe(a, 8400).includes("tarifa_fuera_del_cierre"));
  chk("y nombra la liquidación que se lo llevó",
    /#77/.test(a.bloqueadas.find((b) => b.r.id === 8400)?.motivos[0] ?? ""));
}

// ── 8. El hermano no está ni en el periodo ──────────────────────────────────
{
  const rs = [retorno(8400, { reserva_vinculada_id: 8032 })];
  const a = analizarServicios(rs, "cliente", { hermanoDe: () => null, hermanoProbableDe: () => null });
  chk("con el hermano fuera del periodo lo dice", motivosDe(a, 8400).includes("tarifa_fuera_del_periodo"));
}

// ── 9. Ninguno de los dos lleva importe: eso SÍ es un precio que falta ──────
{
  const rs = [ida(8032, { reserva_vinculada_id: 8400, precio_cliente: 0 }), retorno(8400, { reserva_vinculada_id: 8032 })];
  const idx = indiceHermanos(rs);
  const a = analizarServicios(rs, "cliente", {
    hermanoDe: idx.hermanoDe, hermanoProbableDe: idx.hermanoProbableDe,
  });
  chk("los dos tramos en cero siguen pidiendo el precio",
    motivosDe(a, 8032).includes("sin_precio") && motivosDe(a, 8400).includes("sin_precio"));
  chk("y no hay ningún servicio facturable", a.pares.length === 0);
}

// ── 10. Un enlace ya escrito no se pisa con una conjetura ───────────────────
{
  const rs = [
    ida(1, { reserva_vinculada_id: 3 }),
    ida(2),                                        // suelta, misma ruta y día
    retorno(3, { reserva_vinculada_id: 1 }),
  ];
  const idx = indiceHermanos(rs);
  chk("la ida enlazada conserva su retorno", idx.hermanoDe(rs[0])?.id === 3);
  chk("y la suelta no le roba el par", idx.hermanoProbableDe(rs[1]) === null);
  chk("no se propone reparar nada", idx.reparables.length === 0);
}

// ── 11. Enlace cruzado: apunta a un tramo que ya se emparejó con otro ───────
{
  const rs = [
    ida(1, { reserva_vinculada_id: 3 }),
    retorno(3, { reserva_vinculada_id: 1 }),
    retorno(4, { reserva_vinculada_id: 1, hora_servicio: "15:00" }),   // apunta a una ida ya tomada
  ];
  const a = analizarServicios(rs, "cliente");
  chk("el par bueno se arma igual", a.pares.length === 1 && a.pares[0].cabeza.id === 1);
  chk("y el cruzado lo dice en vez de pedir precio", motivosDe(a, 4).includes("enlace_cruzado"),
    motivosDe(a, 4).join(",") || "sin bloqueos");
}

// ── 12. El índice sobre el periodo entero encuentra al hermano de otro grupo ─
{
  const laIda = ida(8032, { reserva_vinculada_id: null, cliente_sede_id: 5 });
  const elRetorno = retorno(8400, { reserva_vinculada_id: 8032, cliente_sede_id: null });
  const idx = indiceHermanos([laIda, elRetorno]);
  chk("el enlace se lee hacia atrás", idx.hermanoDe(laIda)?.id === 8400);
  chk("y se marca como escrito a medias", idx.de(laIda)?.procedencia === "enlace_a_medias");
  chk("con su par reparable", idx.reparables.length === 1);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
