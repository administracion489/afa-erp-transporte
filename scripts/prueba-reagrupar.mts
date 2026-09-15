// Rehacer los renglones de un borrador con la agrupación de hoy, sin perder nada.
//
// `reagruparLineas` es la única función del módulo que BORRA líneas de un documento, y lo
// hace sin transacción porque PostgREST no la da. Eso obliga a dos cosas que solo se pueden
// afirmar ejecutándolas:
//
//   · que primero calcule y valide TODO lo nuevo y solo entonces borre lo viejo — si se
//     invirtiera el orden, un fallo a mitad dejaría las líneas duplicadas y el total al
//     doble, que puede pasar por bueno;
//   · que lo que no se deriva de servicios —las penalidades y descuentos que alguien
//     tecleó— sobreviva intacto, porque reconstruirlo sería borrarlo.
//
// Se prueba con un Supabase en memoria: tablas de verdad, con el orden real de las
// operaciones registrado, para poder afirmar que el borrado va DESPUÉS del cálculo.
//
// Correr:  npx tsx scripts/prueba-reagrupar.mts
import { reagruparLineas } from "../lib/liquidaciones";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ── Supabase en memoria ─────────────────────────────────────────────────────
function fakeSb(tablas: Record<string, any[]>) {
  const ops: string[] = [];
  let seq = 1000;
  const t = (n: string) => (tablas[n] ??= []);

  const consulta = (nombre: string) => {
    const filtros: ((f: any) => boolean)[] = [];
    const q: any = {
      eq(c: string, v: any) { filtros.push((f) => f[c] === v); return q; },
      in(c: string, vs: any[]) { filtros.push((f) => vs.includes(f[c])); return q; },
      order() { return q; },
      maybeSingle() { const d = t(nombre).filter((f) => filtros.every((p) => p(f))); return Promise.resolve({ data: d[0] ?? null, error: null }); },
      single() { const d = t(nombre).filter((f) => filtros.every((p) => p(f))); return Promise.resolve({ data: d[0] ?? null, error: null }); },
      then(res: any) { return Promise.resolve({ data: t(nombre).filter((f) => filtros.every((p) => p(f))), error: null }).then(res); },
    };
    return q;
  };

  const api: any = {
    tablas, ops,
    from(nombre: string) {
      return {
        select: () => consulta(nombre),
        insert(filas: any) {
          const arr = Array.isArray(filas) ? filas : [filas];
          ops.push(`insert:${nombre}×${arr.length}`);
          const creadas = arr.map((f) => ({ id: ++seq, ...f }));
          t(nombre).push(...creadas);
          return {
            select: () => ({ single: () => Promise.resolve({ data: creadas[0], error: null }) }),
            then: (r: any) => Promise.resolve({ error: null }).then(r),
          };
        },
        update(campos: any) {
          const q: any = {
            eq(c: string, v: any) { ops.push(`update:${nombre}`); for (const f of t(nombre)) if (f[c] === v) Object.assign(f, campos); return Promise.resolve({ error: null }); },
            in(c: string, vs: any[]) { ops.push(`update:${nombre}`); for (const f of t(nombre)) if (vs.includes(f[c])) Object.assign(f, campos); return Promise.resolve({ error: null }); },
          };
          return q;
        },
        delete() {
          return {
            in(c: string, vs: any[]) {
              ops.push(`delete:${nombre}×${t(nombre).filter((f) => vs.includes(f[c])).length}`);
              tablas[nombre] = t(nombre).filter((f) => !vs.includes(f[c]));
              return Promise.resolve({ error: null });
            },
            eq(c: string, v: any) {
              ops.push(`delete:${nombre}`);
              tablas[nombre] = t(nombre).filter((f) => f[c] !== v);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return api;
}

/** Un borrador con tres renglones que la agrupación de hoy debería juntar en uno. */
function escenario(extra?: { ajusteEnLinea?: number; conLineaManual?: boolean }) {
  const reservas = [
    // Tres días de la MISMA ruta contratada, separados solo por la hora del nombre.
    { id: 1, codigo: "OS-1", fecha_servicio: "2026-08-03", hora_servicio: "04:25", estado: "finalizada",
      cliente_id: 7, cliente_sede_id: null, ruta_nombre: "RUTA A/ ENTRADA 04:25/ SANTA ANITA→BSF",
      direccion_servicio: "ida", precio_cliente: 550, costo_proveedor: 0, reserva_vinculada_id: null,
      capacidad_contratada: 25, origen_contractual: "contrato", paradas_json: null },
    { id: 2, codigo: "OS-2", fecha_servicio: "2026-08-04", hora_servicio: "06:30", estado: "finalizada",
      cliente_id: 7, cliente_sede_id: null, ruta_nombre: "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF",
      direccion_servicio: "ida", precio_cliente: 550, costo_proveedor: 0, reserva_vinculada_id: null,
      capacidad_contratada: 25, origen_contractual: "contrato", paradas_json: null },
    { id: 3, codigo: "OS-3", fecha_servicio: "2026-08-05", hora_servicio: "06:35", estado: "finalizada",
      cliente_id: 7, cliente_sede_id: null, ruta_nombre: "RUTA A/ ENTRADA 06:35/ SANTA ANITA→BSF",
      direccion_servicio: "ida", precio_cliente: 550, costo_proveedor: 0, reserva_vinculada_id: null,
      capacidad_contratada: 25, origen_contractual: "contrato", paradas_json: null },
  ];
  // Como los habría dejado la agrupación VIEJA: un renglón por redacción del nombre.
  const lineas = reservas.map((r, i) => ({
    id: 10 + i, liquidacion_id: 1, item: i + 1, tipo: "servicio",
    descripcion: `TRANSPORTE DE PERSONAL\n${r.ruta_nombre}`, unidad_medida: "SERV.",
    cantidad_programada: 1, cantidad_ejecutada: 1, cantidad: 1,
    cantidad_motivo: extra?.ajusteEnLinea === i ? "el cliente canceló media vuelta" : null,
    pax_contratado: 25, precio_unitario: 550, total_linea: 550,
    agrupacion_clave: `${r.ruta_nombre.toUpperCase()}||550.00|contrato`, referencia: null,
  }));
  if (extra?.conLineaManual)
    lineas.push({
      id: 99, liquidacion_id: 1, item: 4, tipo: "descuento" as any,
      descripcion: "PENALIDAD POR RETRASO 12-08", unidad_medida: "UND",
      cantidad_programada: null as any, cantidad_ejecutada: null as any, cantidad: 1,
      cantidad_motivo: null, pax_contratado: null as any, precio_unitario: 200, total_linea: 200,
      agrupacion_clave: null as any, referencia: null,
    });
  return {
    liquidacion_cliente: [{ id: 1, codigo: "LQC-2026-000004", estado: "borrador", cliente_id: 7,
      cliente_sede_id: null, periodo_desde: "2026-08-01", periodo_hasta: "2026-08-31",
      precios_incluyen_igv: false, igv_pct: 18, orden_compra: null, servicio_contratado: null }],
    liquidacion_cliente_linea: lineas,
    liquidacion_cliente_linea_reserva: reservas.map((r, i) => ({ id: 100 + i, linea_id: 10 + i, reserva_id: r.id })),
    reservas,
    cliente_ruta: [], cliente_sedes: [], vehiculos: [], vehiculos_tercero: [],
    cotizaciones: [], liquidacion_evento: [],
  } as Record<string, any[]>;
}

// ── 1 · Junta los tres renglones en uno, sin mover un sol ───────────────────
titulo("1 · Tres renglones de la misma ruta pasan a ser uno");
{
  const tablas = escenario();
  const sb = fakeSb(tablas);
  const r = await reagruparLineas(sb, "cliente", 1);
  ok(r.ok, "reagrupa sin error", r.error ?? "");
  ok(r.antes === 3 && r.despues === 1, "3 → 1 ítem", `${r.antes} → ${r.despues}`);

  const ls = tablas.liquidacion_cliente_linea;
  ok(ls.length === 1, "queda un solo renglón", ls.length);
  ok(ls[0].cantidad === 3, "con los 3 servicios", ls[0].cantidad);
  ok(ls[0].total_linea === 1650, "y el total no se movió", `S/ ${ls[0].total_linea}`);
  ok(ls[0].pax_contratado === 25, "conserva la capacidad contratada", ls[0].pax_contratado);

  const puente = tablas.liquidacion_cliente_linea_reserva;
  ok(puente.length === 3, "el puente conserva los 3 servicios", puente.length);
  ok(new Set(puente.map((p: any) => p.linea_id)).size === 1, "todos colgando de la línea nueva");
}

// ── 2 · Primero calcular, DESPUÉS borrar ────────────────────────────────────
titulo("2 · No borra nada hasta tener lo nuevo calculado");
{
  const sb = fakeSb(escenario());
  await reagruparLineas(sb, "cliente", 1);
  const ops: string[] = sb.ops;
  const primerBorrado = ops.findIndex((o) => o.startsWith("delete:"));
  const primerInsert = ops.findIndex((o) => o.startsWith("insert:liquidacion_cliente_linea"));
  ok(primerBorrado >= 0 && primerInsert > primerBorrado,
    "borra lo viejo y luego inserta lo nuevo (no al revés: duplicaría el total)",
    ops.filter((o) => /delete|insert:liquidacion_cliente_linea/.test(o)).join(" · "));
}

// ── 3 · Las líneas escritas a mano no se tocan ──────────────────────────────
titulo("3 · La penalidad tecleada a mano sobrevive");
{
  const tablas = escenario({ conLineaManual: true });
  const sb = fakeSb(tablas);
  const r = await reagruparLineas(sb, "cliente", 1);
  ok(r.manuales === 1, "reconoce la línea manual", r.manuales);
  const manual = tablas.liquidacion_cliente_linea.find((l: any) => l.id === 99);
  ok(!!manual, "sigue existiendo con su id original");
  ok(manual?.descripcion === "PENALIDAD POR RETRASO 12-08", "con su texto intacto", manual?.descripcion);
  ok(manual?.item === 2, "y renumerada detrás de los servicios", manual?.item);
}

// ── 4 · Las cantidades fijadas a mano ───────────────────────────────────────
//
// El ítem nuevo se rotula con la redacción MÁS USADA de la ruta (y el alfabético desempata).
// Así que un ajuste manual sobrevive o no según su línea aporte o no ese nombre — y las dos
// ramas tienen que comportarse bien: la que sobrevive, trasladándose con su motivo; la que
// no, DICIÉNDOSE, porque callar una decisión que alguien tomó y justificó por escrito es
// perderla sin que nadie se entere.
titulo("4a · El ajuste cuya línea da nombre al ítem nuevo se TRASLADA");
{
  const tablas = escenario({ ajusteEnLinea: 0 });   // la del 04:25, que es la dominante
  const sb = fakeSb(tablas);
  const r = await reagruparLineas(sb, "cliente", 1);
  ok(r.ok, "reagrupa", r.error ?? "");
  ok((r.ajustesPerdidos?.length ?? 0) === 0, "no reporta ninguno perdido", JSON.stringify(r.ajustesPerdidos));
  const l = tablas.liquidacion_cliente_linea[0];
  ok(l.cantidad === 1, "conserva la cantidad que se había fijado a mano", l.cantidad);
  ok(l.cantidad_motivo === "el cliente canceló media vuelta", "y su motivo", l.cantidad_motivo);
  ok(l.total_linea === 550, "el total sigue la cantidad fijada, no la ejecutada", `S/ ${l.total_linea}`);
}

titulo("4b · El ajuste que se queda sin destino se DICE, no se traga");
{
  const tablas = escenario({ ajusteEnLinea: 2 });   // la del 06:35, que NO da nombre al ítem
  const sb = fakeSb(tablas);
  const r = await reagruparLineas(sb, "cliente", 1);
  ok(r.ok, "reagrupa igual", r.error ?? "");
  ok((r.ajustesPerdidos?.length ?? 0) === 1,
    "avisa del ajuste que no tiene dónde ir — su ítem se fundió con otro",
    JSON.stringify(r.ajustesPerdidos));
  ok(tablas.liquidacion_cliente_linea[0].cantidad === 3,
    "y la línea nueva sale con la cantidad ejecutada, sin heredar un ajuste ajeno",
    tablas.liquidacion_cliente_linea[0].cantidad);
}

// ── 5 · Un documento emitido no se toca ─────────────────────────────────────
titulo("5 · Solo sobre borrador");
{
  const tablas = escenario();
  tablas.liquidacion_cliente[0].estado = "emitida";
  const sb = fakeSb(tablas);
  const r = await reagruparLineas(sb, "cliente", 1);
  ok(!r.ok, "se niega");
  ok(/emitida|borrador/i.test(String(r.error)), "y dice por qué y qué hacer", r.error);
  ok(tablas.liquidacion_cliente_linea.length === 3, "sin haber tocado ninguna línea", tablas.liquidacion_cliente_linea.length);
}

console.log(fallos ? `\n${fallos} FALLA(S)\n` : "\nTODO OK\n");
process.exit(fallos ? 1 : 0);
