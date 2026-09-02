// Pruebas del ORIGEN CONTRACTUAL en la liquidación. NO tocan la base: son datos en
// memoria contra el módulo puro de agrupación.
// Uso:  npx tsx scripts/prueba-adicionales.mts   (sale con código 1 si algo falla)
//
// Cubren lo que el módulo tiene que garantizar y no se ve a simple vista: que un
// adicional a la MISMA ruta y a la MISMA tarifa que el contrato no se funda con él
// (que era el caso que lo hacía desaparecer como concepto), que caiga en el subtotal
// de adicionales del formato, que el par ida+retorno adicional siga contando como UN
// servicio, que la "salida adicional" suelta lleve el importe ella misma, y que sin la
// migración de reservas-04 todo se siga leyendo como contratado.
import {
  analizarServicios, agruparServicios, totalesValorizacion,
  type ReservaLiq, type CatalogoLiq,
} from "../lib/liquidacion-agrupacion";

const cat: CatalogoLiq = {
  placaDe: (r) => (r.vehiculo_id ? `P-${r.vehiculo_id}` : ""),
  capacidadDe: () => 20,
  conductorDe: () => "",
  paxContratadoDe: () => 15,
};

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const base = (id: number, over: Partial<ReservaLiq> = {}): ReservaLiq => ({
  id,
  fecha_servicio: "2026-08-12",
  hora_servicio: "06:35",
  estado: "finalizada",
  cliente_id: 1,
  ruta_nombre: "RUTA A/ ENTRADA 06:35/ SANTA ANITA→BSF",
  direccion_servicio: "ida",
  precio_cliente: 350,
  vehiculo_id: 7,
  ...over,
});

const opts = {
  lado: "cliente" as const,
  catalogo: cat,
  preciosIncluyenIgv: false,
  igvPct: 18,
  desde: "2026-08-01",
  hasta: "2026-08-31",
};

// ── 1. Mismo nombre de ruta y MISMA tarifa, uno de contrato y otro adicional ──
{
  const rs = [
    base(1, { fecha_servicio: "2026-08-03" }),
    base(2, { fecha_servicio: "2026-08-04" }),
    base(3, { fecha_servicio: "2026-08-12", origen_contractual: "adicional" }),
  ];
  const { pares } = analizarServicios(rs, "cliente");
  const lineas = agruparServicios(pares, opts);
  chk("misma ruta y misma tarifa NO se funden", lineas.length === 2,
      `${lineas.length} línea(s): ${lineas.map(l => `${l.tipo}×${l.cantidad}`).join(", ")}`);
  chk("el contrato va primero", lineas[0]?.tipo === "servicio");
  chk("el adicional es tipo adicional", lineas[1]?.tipo === "adicional");
  chk("el adicional se rotula en la descripción",
      /^SERVICIO ADICIONAL/.test(lineas[1]?.descripcion ?? ""),
      JSON.stringify((lineas[1]?.descripcion ?? "").split("\n")[0]));
  chk("el contrato NO se rotula", !/ADICIONAL/.test(lineas[0]?.descripcion ?? ""));

  const t = totalesValorizacion(lineas, 18);
  chk("subtotal reparte 2 servicios + 1 adicional",
      t.servicios === 700 && t.adicionales === 350,
      `servicios ${t.servicios} · adicionales ${t.adicionales}`);
}

// ── 2. Adicional con OTRO precio: dos líneas, cada una con lo suyo ──────────
{
  const rs = [
    base(10, { fecha_servicio: "2026-08-03" }),
    base(11, { fecha_servicio: "2026-08-14", origen_contractual: "adicional", precio_cliente: 480 }),
  ];
  const lineas = agruparServicios(analizarServicios(rs, "cliente").pares, opts);
  const ad = lineas.find(l => l.tipo === "adicional");
  chk("el adicional conserva su propio precio", ad?.precio_unitario === 480, String(ad?.precio_unitario));
  const t = totalesValorizacion(lineas, 18);
  chk("total = 350 + 480", t.subtotal === 830, String(t.subtotal));
}

// ── 3. Par ida+retorno adicional: un solo servicio, marcado ────────────────
{
  const ida = base(20, { id: 20, origen_contractual: "adicional", reserva_vinculada_id: 21, precio_cliente: 480 });
  const ret = base(21, {
    id: 21, origen_contractual: "adicional", reserva_vinculada_id: 20,
    direccion_servicio: "retorno", precio_cliente: 0, hora_servicio: "17:00",
    ruta_nombre: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA",
  });
  const { pares } = analizarServicios([ida, ret], "cliente");
  chk("el par adicional es UN servicio", pares.length === 1, `${pares.length} par(es)`);
  const lineas = agruparServicios(pares, opts);
  chk("una sola línea", lineas.length === 1);
  chk("marcada como adicional", lineas[0]?.tipo === "adicional");
  chk("imprime los dos tramos",
      /IDA · RUTA A\/ ENTRADA/.test(lineas[0].descripcion) && /RETORNO · RUTA A\/ RETORNO/.test(lineas[0].descripcion));
  chk("cantidad 1, no 2", lineas[0]?.cantidad === 1, String(lineas[0]?.cantidad));
}

// ── 4. Solo el RETORNO (la "salida adicional"): lleva el importe él ────────
{
  const ret = base(30, {
    id: 30, origen_contractual: "adicional", direccion_servicio: "retorno",
    hora_servicio: "17:00", precio_cliente: 480,
    ruta_nombre: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA",
  });
  const { pares, bloqueadas } = analizarServicios([ret], "cliente");
  chk("el retorno suelto NO se bloquea por falta de precio", bloqueadas.length === 0,
      bloqueadas.map(b => b.motivos.join("/")).join(" | "));
  const lineas = agruparServicios(pares, opts);
  chk("sale una línea de solo retorno", lineas.length === 1 && lineas[0].nombre_ida === null,
      `ida=${lineas[0]?.nombre_ida}`);
  chk("cobra S/ 480", lineas[0]?.total_linea === 480, String(lineas[0]?.total_linea));
}

// ── 5. Sin la migración (columna ausente) todo se lee como contrato ────────
{
  const rs = [base(40, { fecha_servicio: "2026-08-03" }), base(41, { fecha_servicio: "2026-08-04" })];
  const lineas = agruparServicios(analizarServicios(rs, "cliente").pares, opts);
  chk("sin columna → una sola línea de servicio", lineas.length === 1 && lineas[0].tipo === "servicio");
  chk("origen por defecto = contrato", lineas[0].origen_contractual === "contrato");
  const t = totalesValorizacion(lineas, 18);
  chk("no aparece subtotal de adicionales", t.adicionales === 0);
}

// ── 6. Contingencia: se separa igual, con su propio rótulo ─────────────────
{
  const rs = [
    base(50, { fecha_servicio: "2026-08-03" }),
    base(51, { fecha_servicio: "2026-08-05", origen_contractual: "contingencia", precio_cliente: 0 }),
  ];
  const { pares, bloqueadas } = analizarServicios(rs, "cliente");
  chk("la contingencia en S/ 0 se bloquea por sin precio",
      bloqueadas.some(b => b.motivos.some(m => /precio/i.test(m))),
      `${bloqueadas.length} bloqueada(s)`);
  const lineas = agruparServicios(pares, opts);
  chk("solo entra el contratado", lineas.length === 1 && lineas[0].tipo === "servicio");
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
