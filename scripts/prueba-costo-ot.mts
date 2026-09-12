// Matriz de lib/mantenimiento/costo-ot.ts — el costo de una OT, su fila autoritativa y la
// factura del taller.
//
//     npx tsx scripts/prueba-costo-ot.mts
//
// Lo que fija:
//   1 · Un solo total, con su ORIGEN declarado (ítems o tecleado, nunca los dos).
//   2 · El costo SIGUE a la fila de `mantenimiento`, que es la que cuenta el dinero.
//   3 · Sin ancla NO se inventa una fila: duplicar un egreso es el error que no vuelve.
//   4 · La factura se COTEJA; el ~18 % tiene código propio porque no hay nada que corregir.
import { createRequire } from "node:module";
const requerir = createRequire(import.meta.url);
const M = requerir("../lib/mantenimiento/costo-ot") as typeof import("../lib/mantenimiento/costo-ot");

const { totalDeOT, planDeSincronizacion, cotejarFacturaConOT, llaveFiscal, otEnDescripcion, aCentimos } = M;

let fallos = 0;
const ok = (cond: boolean, etq: string, det = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${etq}${det ? "  → " + det : ""}`);
  if (!cond) fallos++;
};
const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ── 1 · El total y su origen ─────────────────────────────────────────────────

linea("1 · UN SOLO TOTAL, CON SU ORIGEN DECLARADO");

const sinCosto = [{ id: 1, costo: null }, { id: 2, costo: null }, { id: 3, costo: null }];

const t1 = totalDeOT(sinCosto, 450);
ok(t1.origen === "tecleado" && t1.total === 450, "nadie itemizó → manda el total tecleado", `${t1.origen} · ${t1.total}`);

const t2 = totalDeOT([{ id: 1, costo: 120.5 }, { id: 2, costo: 80.25 }, { id: 3, costo: null }], 999);
ok(t2.origen === "items" && t2.total === 200.75,
   "con ítems con costo, el total es la SUMA y el tecleado NO manda", `${t2.total} (tecleado 999 ignorado)`);
ok(t2.itemsConCosto === 2 && t2.itemsTotales === 3, "…y se dice cuántos ítems lo componen");
ok(/borra los costos/.test(t2.detalle), "…y cómo volver a teclearlo", t2.detalle.slice(0, 60) + "…");

const t3 = totalDeOT([{ id: 1, costo: 0 }, { id: 2, costo: null }], 300);
ok(t3.origen === "items" && t3.total === 0,
   "un ítem en 0 SÍ cuenta como itemizado",
   "«esta revisión no costó nada» es un dato que alguien escribió; null es no haberlo tocado");

const t4 = totalDeOT(sinCosto, null);
ok(t4.origen === "sin_dato" && t4.total === 0, "sin ítems y sin total → sin_dato, no un cero mudo");
ok(/S\/km|categoría/.test(t4.detalle), "…y el detalle dice qué se rompe con ese cero", t4.detalle.slice(0, 70) + "…");

const t5 = totalDeOT(sinCosto, 0);
ok(t5.origen === "sin_dato", "un total tecleado en 0 tampoco es un dato de costo");

// La suma no puede arrastrar basura de coma flotante: de aquí sale un importe.
const t6 = totalDeOT([{ id: 1, costo: 1234.56 }, { id: 2, costo: 0.1 }, { id: 3, costo: 0.2 }], null);
ok(t6.total === 1234.86, "la suma se redondea al céntimo", `${t6.total}`);
ok(aCentimos(0.1 + 0.2) === 0.3, "aCentimos mata el 0.30000000000000004");

// Invariante por barrido: el origen determina el número, siempre.
let cruces = 0;
for (const items of [[], sinCosto, [{ id: 1, costo: 5 }], [{ id: 1, costo: 5 }, { id: 2, costo: 0 }]]) {
  for (const tec of [null, 0, 10, 999]) {
    const r = totalDeOT(items as any, tec);
    const suma = aCentimos((items as any[]).filter(i => i.costo !== null).reduce((s, i) => s + Number(i.costo), 0));
    const esperado = r.origen === "items" ? suma : r.origen === "tecleado" ? aCentimos(Number(tec)) : 0;
    if (r.total !== esperado) cruces++;
  }
}
ok(cruces === 0, "INVARIANTE · el total es siempre el que dice su origen", "16 combinaciones");

// ── 2 y 3 · La fila autoritativa ─────────────────────────────────────────────

linea("2 · EL COSTO SIGUE A LA FILA QUE CUENTA EL DINERO");
console.log("`v_egresos` suma mantenimiento.costo, no ordenes_trabajo.costo_total. Antes se copiaba");
console.log("UNA vez al cerrar: una OT automática nacía en 0, se cerraba en 0 y quedaba en 0 para siempre.\n");

const OT_ABIERTA = { estado: "abierta", mantenimiento_id: null, km_cierre: null, documento_compra_id: null };
const OT_CERRADA = { estado: "cerrada", mantenimiento_id: 77, km_cierre: 15000, documento_compra_id: null };
const FILA_CERO = { costo: 0, kilometraje: 15000, documento_compra_id: null };

const p1 = planDeSincronizacion(OT_ABIERTA, 450, null);
ok(p1.codigo === "sin_cierre" && !Object.keys(p1.patch).length,
   "una OT abierta no asienta egreso", "el dinero se asienta cuando el servicio se hizo");

const p2 = planDeSincronizacion(OT_CERRADA, 450, FILA_CERO);
ok(p2.codigo === "actualiza" && p2.patch.costo === 450,
   "EL CASO REPORTADO · cerrada en 0 y corregida después → la fila se reescribe", p2.detalle);

const p3 = planDeSincronizacion(OT_CERRADA, 450, { costo: 450, kilometraje: 15000, documento_compra_id: null });
ok(p3.codigo === "sin_cambio" && !Object.keys(p3.patch).length, "si ya dice lo mismo, no se escribe");

const p4 = planDeSincronizacion(
  { ...OT_CERRADA, km_cierre: 16200 }, 450, { costo: 450, kilometraje: 15000, documento_compra_id: null });
ok(p4.codigo === "actualiza" && p4.patch.kilometraje === 16200,
   "el kilometraje se arrastra igual",
   "sin km no hay tramo medible, y el S/km de la categoría se queda sin número");

const p5 = planDeSincronizacion({ ...OT_CERRADA, documento_compra_id: 31 }, 450, { costo: 450, kilometraje: 15000, documento_compra_id: null });
ok(p5.codigo === "actualiza" && p5.patch.documento_compra_id === 31, "la factura enlazada baja a la fila");

linea("3 · SIN ANCLA NO SE INVENTA UNA FILA");
const p6 = planDeSincronizacion({ ...OT_CERRADA, mantenimiento_id: null }, 450, null);
ok(p6.codigo === "sin_ancla" && !Object.keys(p6.patch).length,
   "cerrada sin FK → no se toca ninguna fila",
   "insertar una nueva duplicaría un egreso ya asentado: el error que no vuelve");
ok(/migración|mantenimiento-05/.test(p6.detalle), "…y se dice dónde se arregla", p6.detalle.slice(0, 70) + "…");

// Invariante dura: ningún plan escribe sobre una fila que no es suya.
let escrituras = 0;
for (const estado of ["abierta", "cerrada", "en_proceso", ""]) {
  for (const mid of [null, 77]) {
    for (const fila of [null, FILA_CERO]) {
      const pl = planDeSincronizacion({ estado, mantenimiento_id: mid, km_cierre: 15000, documento_compra_id: null }, 450, fila as any);
      if (Object.keys(pl.patch).length && (estado !== "cerrada" || !mid || !fila)) escrituras++;
    }
  }
}
ok(escrituras === 0,
   "INVARIANTE · solo se escribe con OT cerrada Y ancla Y fila a la vista", "16 combinaciones");

// ── 4 · La factura ───────────────────────────────────────────────────────────

linea("4 · LA FACTURA SE COTEJA, NO SE COPIA");

const c1 = cotejarFacturaConOT(450, null);
ok(c1.codigo === "sin_factura" && c1.detalle === "", "sin factura no se afirma nada");

const c2 = cotejarFacturaConOT(450, 450);
ok(c2.codigo === "coincide" && c2.detalle === "", "iguales → silencio, sin chip");

const c3 = cotejarFacturaConOT(450, 531);   // 450 × 1.18
ok(c3.codigo === "difiere_igv",
   "el ~18 % tiene CÓDIGO PROPIO: es lo normal, no un desacuerdo",
   "factura con IGV contra costo sin IGV; copiarla subiría el S/km de la categoría un 18 %");
ok(/crédito fiscal|18 %/.test(c3.detalle), "…y el detalle lo explica", c3.detalle.slice(0, 70) + "…");

const c4 = cotejarFacturaConOT(450, 980);
ok(c4.codigo === "discrepa" && Math.abs(c4.diferencia - 530) < 0.01,
   "una diferencia que no es el IGV sí se levanta", `Δ ${c4.diferencia}`);
ok(/costo por kilómetro|categoría/.test(c4.detalle), "…nombrando qué decide ese número");

ok(cotejarFacturaConOT(450, 450.01).codigo === "coincide",
   "un céntimo de holgura: los totales se redondean en dos sitios");

// El lado que no se puede aflojar: una factura de verdad distinta tiene que seguir saliendo.
ok(cotejarFacturaConOT(1000, 1200).codigo === "discrepa",
   "LO QUE NO SE AFLOJA · +20 % no es el IGV y sigue siendo un desacuerdo", "Δ 200");

linea("5 · LA LLAVE FISCAL, DERIVADA EN UN SOLO SITIO");
const k = llaveFiscal({ ruc_emisor: "20127765279", tipo_comprobante: "factura", serie: "F001", numero: "00025" });
ok(k === "20127765279|factura|F001|25", "normaliza RUC, serie y ceros a la izquierda", String(k));
ok(llaveFiscal({ ruc_emisor: "20-127765279", serie: "f001", numero: "25" }) === k,
   "la misma factura tecleada de otra forma da la MISMA llave",
   "si no, la factura del taller entraría dos veces: una por Contabilidad y otra por la OT");
ok(llaveFiscal({ ruc_emisor: "20127765279", serie: "", numero: "25" }) === null,
   "sin serie no hay llave: sin ella no se puede afirmar que la factura sea nueva");

linea("6 · LA ADOPCIÓN DE LAS FILAS VIEJAS");
ok(otEnDescripcion("OT #4 — CWZ-371") === 4, "lee el número del texto que era el único vínculo");
ok(otEnDescripcion("OT #123") === 123, "…con varios dígitos");
ok(otEnDescripcion("Cambio de aceite") === null, "…y no inventa uno donde no lo hay");
ok(otEnDescripcion("COT #4") === null, "…ni lo confunde con otro prefijo");

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
