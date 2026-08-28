// Pruebas del helper del Pacto. NO tocan la base: el cliente de Supabase es falso.
// Uso:  npx tsx scripts/prueba-pacto.mts   (sale con código 1 si algo falla)
//
// Cubren lo que se rompió de verdad durante el desarrollo: la coherencia de la
// asignación (un servicio que pasa a flota propia arrastraba la empresa y el costo
// del proveedor, y la liquidación le habría cobrado un servicio que nunca prestó),
// la comparación de costos con distinta afectación de IGV, y que un lote fallido
// diga CUÁL fila falló en vez de morir entero sin nombres.
import { normalizarAsignacion, avisosDe, margenEnVivo, guardarReservas, describirResultado }
  from "../lib/reservas-pacto";

let fallos = 0;
const ok = (cond: boolean, etq: string, detalle = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${etq}${detalle ? "  → " + detalle : ""}`);
  if (!cond) fallos++;
};

console.log("\n── normalizarAsignacion ──");
const vt = [{ id: 7, empresa_id: 42 }];
const a = normalizarAsignacion({ tipo_asignacion: "propio", vehiculo_tercero_id: 7 }, vt);
ok(a.empresa_tercerizada_id === 42 && a.tipo_asignacion === "tercerizado" && a.tipo === "tercerizada",
   "el bug de cotizaciones:1223 se repara: deriva la empresa y corrige el tipo",
   JSON.stringify({emp:a.empresa_tercerizada_id, tipo:a.tipo_asignacion}));

const b = normalizarAsignacion({ tipo_asignacion: "propio", vehiculo_id: 3, conductor_id: 4,
  empresa_tercerizada_id: 9, costo_proveedor: 500 }, vt);
ok(b.empresa_tercerizada_id === null && b.costo_proveedor === 0,
   "pasar a flota propia limpia la empresa y el costo del proveedor",
   `emp=${b.empresa_tercerizada_id} costo=${b.costo_proveedor}`);

const c = normalizarAsignacion({ tipo_asignacion: "tercerizado", empresa_tercerizada_id: 9,
  vehiculo_id: 3, conductor_id: 4 }, vt);
ok(c.vehiculo_id === null && c.conductor_id === null,
   "un tercerizado no arrastra unidad ni conductor propios");

console.log("\n── margenEnVivo (normalizado por IGV) ──");
const g = margenEnVivo(1180, 550, { compraAfectacion: "10", emiteFactura: true });
const e = margenEnVivo(1180, 500, { compraAfectacion: "20", emiteFactura: true });
ok(Math.abs(g.costo - 466.10) < 0.01, "proveedor gravado de 550 cuesta 466.10", String(g.costo));
ok(Math.abs(e.costo - 500.00) < 0.01, "taxi exonerado de 500 cuesta 500.00", String(e.costo));
ok(g.pct! > e.pct!, "el 'caro' de 550 deja MEJOR margen que el 'barato' de 500",
   `${g.pct}% vs ${e.pct}%`);

console.log("\n── avisosDe ──");
const av1 = avisosDe({ tipo_asignacion: "tercerizado", costo_proveedor: 0 });
ok(av1.some(x => x.nivel === "alerta"), "tercerizado sin costo dispara alerta");
const av2 = avisosDe({ tipo_asignacion: "tercerizado", costo_proveedor: 550, precio_cliente: 1400 },
                     { costo_proveedor: 500, precio_cliente: 1180 });
ok(av2.some(x => x.texto.includes("motivo")), "costo cambiado sin motivo lo pide");
ok(av2.some(x => x.texto.includes("conformidad")), "precio al alza anuncia la conformidad");

console.log("\n── guardarReservas: rechazos con nombre ──");
// Supabase falso: el lote entero falla, pero fila por fila solo falla el id 2.
const sbFalso = {
  from() {
    const q: any = { _ids: [] as number[] };
    q.update = () => q;
    q.in = (_c: string, ids: number[]) => { q._ids = ids; return Promise.resolve({ error: { message: "boom en el lote" } }); };
    q.eq = (_c: string, id: number) => Promise.resolve({ error: id === 2 ? { message: "violates check constraint" } : null });
    return q;
  },
};
const r = await guardarReservas(sbFalso, [1, 2, 3], { costo_proveedor: 500 });
ok(r.guardados.length === 2 && r.rechazos.length === 1 && r.rechazos[0].id === 2,
   "el lote falla → reintenta fila por fila y NOMBRA al culpable",
   `guardados=${JSON.stringify(r.guardados)} rechazo=#${r.rechazos[0]?.id}`);
ok(describirResultado(r).includes("#2"), "el resumen dice cuál falló");

console.log("\n── guardarReservas: degradación sin las migraciones ──");
let intentos = 0;
const sbSinPacto = {
  from() {
    const q: any = {};
    let patch: any = {};
    q.update = (p: any) => { patch = p; return q; };
    q.in = () => {
      intentos++;
      if ("cambio_motivo" in patch)
        return Promise.resolve({ error: { message: 'column "cambio_motivo" does not exist' } });
      return Promise.resolve({ error: null });
    };
    q.eq = () => Promise.resolve({ error: null });
    return q;
  },
};
const r2 = await guardarReservas(sbSinPacto, [10, 11], { costo_proveedor: 500 }, { motivo: "proveedor_sin_unidad" });
ok(r2.ok && r2.guardados.length === 2, "guarda igual sin las migraciones corridas");
ok(!!r2.aviso && r2.aviso.includes("pacto-00"), "avisa qué migración falta", r2.aviso ?? "");
ok(intentos === 2, "reintentó exactamente una vez, sin las columnas del Pacto", `intentos=${intentos}`);

console.log(`\n${fallos === 0 ? "✅ TODO EN VERDE" : `❌ ${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
