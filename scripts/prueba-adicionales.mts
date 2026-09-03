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
  analizarServicios, agruparServicios, totalesValorizacion, origenDeTramos,
  type ReservaLiq, type CatalogoLiq,
} from "../lib/liquidacion-agrupacion";
import { planDeCanje, notaDeCanje, efectoDeMarcarTramo } from "../lib/reservas-canje";

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

// ── 7. CANJE de origen: los dos servicios cambian de lado a la vez ────────
//
// El caso real: un día de contrato (ida + retorno, la tarifa en la ida) y una salida
// adicional que se intercambiaron las unidades por una contingencia. Marcar uno solo
// movería el día entero de subtotal; el canje corrige la etiqueta sin mover un sol.
{
  const contrato = [
    { id: 60, codigo: "OS-2026-008161", precio_cliente: 350 },
    { id: 61, codigo: "OS-2026-008162", precio_cliente: 0 },
  ];
  const adicional = [{ id: 70, codigo: "OS-2026-008155", precio_cliente: 350 }];

  const p = planDeCanje(contrato, adicional, "adicional");
  chk("el lado marcado va a adicional", p.a.destino === "adicional" && p.b.destino === "contrato");
  chk("el importe del día es la suma de sus tramos", p.a.importe === 350, String(p.a.importe));
  chk("a misma tarifa el neto es cero", p.netoAdicionales === 0, String(p.netoAdicionales));
  chk("aplicable", p.aplicable);
  chk("avisa que no es simétrico (2 tramos contra 1)",
      p.avisos.some(a => /simétrico/i.test(a)));
  chk("a neto cero no habla de subir ni bajar el subtotal",
      !p.avisos.some(a => /sube|baja/i.test(a)));

  // Tarifas distintas: el subtotal de adicionales SÍ se mueve y hay que decirlo.
  const caro = planDeCanje(contrato, [{ id: 70, codigo: "X", precio_cliente: 480 }], "adicional");
  chk("neto = lo que entra menos lo que sale", caro.netoAdicionales === -130,
      String(caro.netoAdicionales));
  chk("avisa que el subtotal baja", caro.avisos.some(a => /baja/i.test(a)));

  // Al revés: el botón fue "Devolver a CONTRATO" y el canje manda el otro a adicional.
  const alReves = planDeCanje(adicional, contrato, "contrato");
  chk("el destino del lado marcado manda", alReves.a.destino === "contrato" && alReves.b.destino === "adicional");
  chk("el neto se mide siempre sobre los adicionales", alReves.netoAdicionales === 0);

  // Dos tramos del MISMO día no son un intercambio: escribirían valores opuestos
  // sobre la misma fila.
  const solapado = planDeCanje(contrato, [contrato[1]], "adicional");
  chk("con tramos compartidos no es aplicable", !solapado.aplicable && solapado.solapados.length === 1);

  const sinLado = planDeCanje(contrato, [], "adicional");
  chk("sin contraparte no es aplicable", !sinLado.aplicable);

  chk("la nota nombra a la contraparte",
      notaDeCanje("Cambio por avería", ["OS-2026-008155"])
        === "Cambio por avería · Canje de origen con OS-2026-008155");
  chk("sin nota escrita queda igual el rastro del canje",
      notaDeCanje("  ", ["A", "B"]) === "Canje de origen con A, B");
}

// ── 8. Par MIXTO: clasifica el tramo que lleva el importe, y se avisa ─────
//
// La regla que reemplazó al contagio. Antes bastaba con marcar el retorno —que va en
// S/ 0.00 a propósito— para que el día entero saltara al subtotal de adicionales sin
// que nadie moviera una tarifa. Ahora quien cobra, clasifica.
{
  const par = (over: { ida?: string; ret?: string }) => [
    base(80, { id: 80, reserva_vinculada_id: 81, precio_cliente: 350, origen_contractual: over.ida }),
    base(81, {
      id: 81, reserva_vinculada_id: 80, precio_cliente: 0, direccion_servicio: "retorno",
      hora_servicio: "17:00", origen_contractual: over.ret,
      ruta_nombre: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA",
    }),
  ];

  // El retorno marcado, la ida (que lleva la tarifa) de contrato → se cobra CONTRATO.
  const a = analizarServicios(par({ ret: "adicional" }), "cliente");
  const la = agruparServicios(a.pares, opts);
  chk("marcar el tramo mudo NO mueve el día de subtotal",
      la.length === 1 && la[0].tipo === "servicio", `${la[0]?.tipo}`);
  chk("el importe sigue en servicios del periodo",
      totalesValorizacion(la, 18).adicionales === 0);
  chk("pero el par mixto AVISA",
      a.avisos.some(v => /marcado como ADICIONAL/.test(v.mensaje)),
      a.avisos.map(v => v.mensaje).join(" | ") || "sin avisos");

  // La ida (la que lleva la tarifa) marcada → el día entero es adicional.
  const b = analizarServicios(par({ ida: "adicional" }), "cliente");
  const lb = agruparServicios(b.pares, opts);
  chk("marcar el tramo que lleva la tarifa SÍ mueve el día",
      lb.length === 1 && lb[0].tipo === "adicional", `${lb[0]?.tipo}`);
  chk("y entra al subtotal de adicionales",
      totalesValorizacion(lb, 18).adicionales === 350);

  // Los dos del mismo lado: ni aviso ni sorpresa.
  const c = analizarServicios(par({ ida: "adicional", ret: "adicional" }), "cliente");
  chk("par coherente no avisa de orígenes distintos",
      !c.avisos.some(v => /marcado como/.test(v.mensaje)));
}

// ── 9. El efecto de marcar medio par, tal como lo anuncia la pantalla ─────
{
  const ida = { id: 90, codigo: "OS-2026-008161", precio_cliente: 350, origen_contractual: "contrato" };
  const ret = { id: 91, codigo: "OS-2026-008162", precio_cliente: 0, origen_contractual: "contrato" };

  const mudo = efectoDeMarcarTramo([ida, ret], [ret.id], "adicional");
  chk("marcar el tramo en S/ 0.00 no mueve la valorización", !mudo.mueveValorizacion);
  chk("y el aviso nombra dónde está la tarifa",
      /OS-2026-008161/.test(mudo.aviso) && /NO se mueve/.test(mudo.aviso), mudo.aviso);
  chk("el portador es la ida", mudo.portador?.id === ida.id);
  chk("el importe del día es 350", mudo.importe === 350);

  const conPlata = efectoDeMarcarTramo([ida, ret], [ida.id], "adicional");
  chk("marcar el tramo con la tarifa sí mueve el día", conPlata.mueveValorizacion);
  chk("y lo dice con el destino y el importe",
      /ADICIONAL/.test(conPlata.aviso) && /350/.test(conPlata.aviso), conPlata.aviso);

  const sinTarifa = efectoDeMarcarTramo(
    [{ ...ida, precio_cliente: 0 }, ret], [ret.id], "adicional");
  chk("sin tarifa en ningún tramo lo dice en vez de inventar un efecto",
      !sinTarifa.mueveValorizacion && /no entra a ninguna liquidación/.test(sinTarifa.aviso),
      sinTarifa.aviso);
}

// ── 10. Los DOS tramos con importe: son dos servicios, no un día ──────────
//
// Estado legal (Programación lo permite tras confirmar el candado del doble cobro).
// `efectoDeMarcarTramo` anunciaba aquí "la valorización no se mueve", que es justo lo
// contrario de lo que pasa: el tramo marcado se lleva su propio importe.
{
  const a = { id: 100, codigo: "A", precio_cliente: 350 };
  const b = { id: 101, codigo: "B", precio_cliente: 200 };

  const e = efectoDeMarcarTramo([a, b], [b.id], "adicional");
  chk("con los dos tramos cobrando, marcar uno SÍ mueve su importe", e.mueveValorizacion);
  chk("y dice cuánto se mueve y cuánto se queda",
      /200\.00/.test(e.aviso) && /350\.00/.test(e.aviso), e.aviso);
  chk("no hay un solo portador que clasifique el día", e.portador === null);

  // Y la liquidación lo respalda: son DOS líneas, cada una con su origen.
  const rs = [
    base(102, { id: 102, reserva_vinculada_id: 103, precio_cliente: 350 }),
    base(103, {
      id: 103, reserva_vinculada_id: 102, precio_cliente: 200, direccion_servicio: "retorno",
      hora_servicio: "17:00", origen_contractual: "adicional",
      ruta_nombre: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA",
    }),
  ];
  const lineas = agruparServicios(analizarServicios(rs, "cliente").pares, opts);
  chk("los dos cobrando salen como dos líneas separadas", lineas.length === 2, `${lineas.length}`);
  const t = totalesValorizacion(lineas, 18);
  chk("cada importe cae en su propio subtotal",
      t.servicios === 350 && t.adicionales === 200,
      `servicios ${t.servicios} · adicionales ${t.adicionales}`);
}

// ── 11. El origen de una LÍNEA entera lo deciden sus tramos con importe ────
//
// `recalcularDescripciones` no tiene pares, solo las reservas del puente de la línea
// (26 días × 2 tramos). Antes tomaba el primer tramo distinto de 'contrato' de TODA la
// línea: un solo retorno marcado —que va en S/ 0.00— rotulaba "SERVICIO ADICIONAL" el
// renglón entero, mientras `tipo` seguía diciendo "servicio". Dos textos distintos
// para la misma línea según se creara o se recalculara.
{
  const dia = (d: number, over: Partial<ReservaLiq> = {}) => [
    base(200 + d * 2, { id: 200 + d * 2, fecha_servicio: `2026-08-${String(d).padStart(2, "0")}`, precio_cliente: 790 }),
    base(201 + d * 2, {
      id: 201 + d * 2, fecha_servicio: `2026-08-${String(d).padStart(2, "0")}`,
      precio_cliente: 0, direccion_servicio: "retorno", hora_servicio: "17:00", ...over,
    }),
  ];
  const linea = [...dia(3), ...dia(12, { origen_contractual: "adicional" }), ...dia(20)];

  chk("un retorno mudo marcado NO reetiqueta la línea",
      origenDeTramos(linea, "cliente") === "contrato",
      origenDeTramos(linea, "cliente"));

  // Y cuando de verdad son adicionales, la línea lo dice: mandan los que cobran.
  const lineaAdic = linea.map(r =>
    Number(r.precio_cliente) > 0 ? { ...r, origen_contractual: "adicional" } : r);
  chk("si los tramos que cobran son adicionales, la línea es adicional",
      origenDeTramos(lineaAdic, "cliente") === "adicional");

  // Sin ningún tramo con importe no se puede inventar: votan todos.
  const sinTarifa = linea.map(r => ({ ...r, precio_cliente: 0 }));
  chk("sin tarifa en la línea vota lo que hay, sin reventar",
      typeof origenDeTramos(sinTarifa, "cliente") === "string");

  // El lado PROVEEDOR mira costo_proveedor, no precio_cliente.
  const porCosto = [
    base(300, { id: 300, precio_cliente: 0, costo_proveedor: 500, origen_contractual: "adicional" }),
    base(301, { id: 301, precio_cliente: 790, costo_proveedor: 0 }),
  ];
  chk("del lado proveedor manda quien lleva el COSTO",
      origenDeTramos(porCosto, "proveedor") === "adicional" &&
      origenDeTramos(porCosto, "cliente") === "contrato");
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
