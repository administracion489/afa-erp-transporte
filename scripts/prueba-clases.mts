// Pruebas de la CLASE de un servicio (fijo | adicional | eventual), que es el eje del
// filtro nuevo de /liquidaciones. NO tocan la base: datos en memoria contra el módulo puro.
// Uso:  npx tsx scripts/prueba-clases.mts   (sale con código 1 si algo falla)
//
// Lo que garantizan, que es lo que no se ve a simple vista:
//
//   · que la clase sea del DÍA y no del tramo — un filtro que juzgara tramo a tramo
//     partiría el par ida+retorno y el superviviente saldría pidiendo que le cobren la
//     tarifa que su hermano YA cobra (el error más caro de este módulo);
//   · que el retorno mudo (S/ 0.00 a propósito) NO contagie su marca al día, la misma
//     regla de `origenDelPar` que ya se derogó una vez por contagiar;
//   · que del lado PROVEEDOR mande quien lleva el COSTO, no el precio;
//   · que sin la migración reservas-04 todo se siga leyendo como contratado.
import {
  claseDeServicio, claseDeTramos, claseDelDia, esServicioFijo, CLASES_SERVICIO,
} from "../lib/liquidacion-clases";
import type { ReservaLiq } from "../lib/liquidacion-agrupacion";

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
  tipo_servicio_detalle: "transporte_personal",
  precio_cliente: 664.41,
  ...over,
});

// ── 1. Un tramo suelto, los tres casos ──────────────────────────────────────
{
  chk("transporte de personal contratado → fijo",
      claseDeServicio(base(1)) === "fijo");
  chk("marcado adicional → adicional",
      claseDeServicio(base(2, { origen_contractual: "adicional" })) === "adicional");
  chk("contingencia también es adicional (no es contrato)",
      claseDeServicio(base(3, { origen_contractual: "contingencia" })) === "adicional");
  chk("full day → eventual",
      claseDeServicio(base(4, { tipo_servicio_detalle: "full_day" })) === "eventual");
  chk("sin tipo de servicio → eventual, como en toda la app",
      claseDeServicio(base(5, { tipo_servicio_detalle: null })) === "eventual");

  // Los cuatro tipos que nacen de una cotización fija (SERVS_FIJO en /cotizaciones).
  for (const t of ["transporte_personal", "fijo_solo_ida", "fijo_multiparada", "fijo_reten"])
    chk(`'${t}' cuenta como fijo`, esServicioFijo({ tipo_servicio_detalle: t }));
  for (const t of ["solo_ida", "ida_retorno", "ida_retorno_paradas", "full_day", "multi_dia"])
    chk(`'${t}' NO cuenta como fijo`, !esServicioFijo({ tipo_servicio_detalle: t }));

  // La marca escrita gana sobre el tipo derivado: es un dato que alguien puso.
  chk("un eventual marcado adicional sale adicional",
      claseDeServicio(base(6, { tipo_servicio_detalle: "full_day", origen_contractual: "adicional" })) === "adicional");
}

// ── 2. El día manda, y lo declara el tramo que lleva el importe ──────────────
{
  const ida = base(10, { direccion_servicio: "ida", precio_cliente: 664.41, reserva_vinculada_id: 11 });
  const retorno = base(11, {
    direccion_servicio: "retorno", precio_cliente: 0, reserva_vinculada_id: 10,
    ruta_nombre: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA",
  });

  chk("día normal → fijo", claseDelDia(ida, retorno, "cliente") === "fijo");

  // El retorno va en S/ 0.00 a propósito: marcarlo NO mueve el día de bolsillo.
  const retornoMarcado = { ...retorno, origen_contractual: "adicional" };
  chk("un retorno mudo marcado NO contagia al día",
      claseDelDia(ida, retornoMarcado, "cliente") === "fijo");
  chk("y el día se ve igual mirándolo desde el retorno",
      claseDelDia(retornoMarcado, ida, "cliente") === "fijo");

  // La marca en el tramo que SÍ cobra mueve el día entero, que es lo correcto.
  const idaAdicional = { ...ida, origen_contractual: "adicional" };
  chk("marcado el tramo que cobra, el día es adicional",
      claseDelDia(idaAdicional, retorno, "cliente") === "adicional" &&
      claseDelDia(retorno, idaAdicional, "cliente") === "adicional");

  // ESTA es la invariante del filtro: los dos tramos del día caen SIEMPRE en la misma
  // clase, así que ningún filtro puede dejar pasar uno y bloquear al otro.
  const casos: [ReservaLiq, ReservaLiq][] = [
    [ida, retorno],
    [ida, retornoMarcado],
    [idaAdicional, retorno],
    [{ ...ida, tipo_servicio_detalle: "full_day" }, { ...retorno, tipo_servicio_detalle: "full_day" }],
    // Cotización fija cuyo retorno se registró sin tipo: basta con que UNO lo declare.
    [ida, { ...retorno, tipo_servicio_detalle: null }],
  ];
  const iguales = casos.every(([a, b]) =>
    claseDelDia(a, b, "cliente") === claseDelDia(b, a, "cliente"));
  chk("los dos tramos de un día caen siempre en la misma clase", iguales);

  chk("el tramo con tipo manda sobre el hermano sin tipo",
      claseDelDia(ida, { ...retorno, tipo_servicio_detalle: null }, "cliente") === "fijo");

  // Sin hermano (el nocturno cuyo retorno cae fuera del periodo) se juzga solo.
  chk("un tramo sin hermano se juzga por sí mismo",
      claseDelDia(ida, null, "cliente") === "fijo" &&
      claseDelDia(idaAdicional, null, "cliente") === "adicional");
}

// ── 3. El lado PROVEEDOR mira el costo, no el precio ─────────────────────────
{
  // El precio de venta está en la ida y el costo pactado con el tercero, en el retorno:
  // pasa cuando la tarifa del proveedor se cargó en el tramo de vuelta.
  const ida = base(20, { precio_cliente: 900, costo_proveedor: 0 });
  const retorno = base(21, {
    direccion_servicio: "retorno", precio_cliente: 0, costo_proveedor: 664.41,
    origen_contractual: "adicional",
  });
  chk("del lado proveedor clasifica quien lleva el COSTO",
      claseDeTramos([ida, retorno], "proveedor") === "adicional");
  chk("y del lado cliente, quien lleva el PRECIO",
      claseDeTramos([ida, retorno], "cliente") === "fijo");
}

// ── 4. Sin la migración reservas-04 (la columna no existe) ───────────────────
{
  const sinColumna = [
    base(30, { origen_contractual: undefined }),
    base(31, { direccion_servicio: "retorno", precio_cliente: 0, origen_contractual: undefined }),
  ];
  chk("sin origen_contractual todo se lee como contratado",
      claseDeTramos(sinColumna, "cliente") === "fijo");
  chk("y un eventual sin la columna sigue siendo eventual",
      claseDeTramos(sinColumna.map((r) => ({ ...r, tipo_servicio_detalle: "multi_dia" })), "cliente") === "eventual");
}

// ── 5. Una línea entera del documento ────────────────────────────────────────
{
  // Tres días de la misma ruta; en uno de ellos alguien marcó el retorno mudo. La línea
  // no puede cambiar de subtotal por eso: los que cobran son los que clasifican.
  const dia = (d: number, over: Partial<ReservaLiq> = {}) => [
    base(100 + d, { fecha_servicio: `2026-08-${String(d).padStart(2, "0")}`, precio_cliente: 664.41 }),
    base(200 + d, { fecha_servicio: `2026-08-${String(d).padStart(2, "0")}`, direccion_servicio: "retorno", precio_cliente: 0, ...over }),
  ];
  const linea = [...dia(3), ...dia(12, { origen_contractual: "adicional" }), ...dia(20)];
  chk("una línea con un retorno mudo marcado sigue siendo fija",
      claseDeTramos(linea, "cliente") === "fijo");

  const lineaAdic = linea.map((r) => (Number(r.precio_cliente) > 0 ? { ...r, origen_contractual: "adicional" } : r));
  chk("si los que cobran son adicionales, la línea es adicional",
      claseDeTramos(lineaAdic, "cliente") === "adicional");

  chk("sin tramos no revienta", typeof claseDeTramos([], "cliente") === "string");
}

// ── 6. El catálogo que se pinta en la pantalla ───────────────────────────────
{
  chk("las tres clases están declaradas y en orden",
      CLASES_SERVICIO.map((c) => c.clave).join(",") === "fijo,adicional,eventual");
  chk("todas traen etiqueta y ayuda",
      CLASES_SERVICIO.every((c) => !!c.etiqueta && !!c.ayuda));
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
