// Pruebas: cargas registradas con OTRO combustible que el de su factura, y el filtro por tipo.
// No tocan la base. Uso:  npx tsx scripts/prueba-tipo-desde-factura.mts
//
// El caso: CWQ400 (van GLP + gasolina). La factura F882-0130996 trae «G-PREMIUM G-PRIX - GASOHOL»
// 6.388 gal = S/ 152.61, la conciliación la dio por «Ya registrada (carga #147, por placa + fecha +
// importe)», y en Combustible no había ninguna carga de gasolina premium: #147 estaba rotulada con
// otro combustible, y el filtro «Gasolina» además no encontraba la premium.
import { tiposPorCorregir, tipoDistinto, notaTipoCorregido, type FacturaParaTipo, type CargaParaTipo } from "../lib/combustible/tipo-desde-factura";
import { coincideTipo } from "../lib/combustible-tipos";

let fallos = 0;
const chk = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "  ok  " : "FALLA "} ${n}${extra ? " — " + extra : ""}`); if (!ok) fallos++; };

const factura = (lineas: FacturaParaTipo["lineas"], conciliacion: FacturaParaTipo["conciliacion"], id = 1): FacturaParaTipo =>
  ({ id, serie: "F882", numero: "0130996", lineas, conciliacion });
const carga = (o: Partial<CargaParaTipo>): CargaParaTipo =>
  ({ id: 147, tipo_combustible: "glp", unidad: "galones", galones: 6.388, total: 152.61, fecha: "2026-09-30", placa: "CWQ400", ...o });
const premium = { n: 1, tipo_combustible: "gasolina_premium", cantidad: 6.388, total: 152.61, descripcion: "G-PREMIUM G-PRIX - GASOHOL" };

// ── 1. El caso real ──────────────────────────────────────────────────────────
{
  const l = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }])], new Map([[147, carga({})]]));
  chk("CWQ400: la carga #147 rotulada GLP con su factura de premium → se propone corregir", l.length === 1 && l[0].carga_id === 147 && l[0].tipo_factura === "gasolina_premium" && l[0].tipo_carga === "glp");
  chk("…a la unidad de la gasolina (galones)", l[0]?.unidad_factura === "galones");
  chk("…nombrando el comprobante y el producto", l[0]?.comprobante === "F882-0130996" && /G-PREMIUM/.test(l[0]?.producto ?? ""));
  chk("la nota dice qué decía antes", /decía GLP/.test(notaTipoCorregido("glp", "F882-0130996")));
}

// ── 2. Lo que NO se propone ──────────────────────────────────────────────────
{
  const sinCantidad = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }])], new Map([[147, carga({ galones: 20 })]]));
  chk("misma plata pero OTRA cantidad → podría ser otro despacho: no se propone", sinCantidad.length === 0);
  const otroImporte = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }])], new Map([[147, carga({ total: 160 })]]));
  chk("otro importe → no se propone", otroImporte.length === 0);
  const yaBien = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }])], new Map([[147, carga({ tipo_combustible: "gasolina_premium" })]]));
  chk("ya dice gasolina premium → nada que corregir", yaBien.length === 0);
  const regular = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }])], new Map([[147, carga({ tipo_combustible: "gasolina_regular" })]]));
  chk("regular vs premium (misma familia, los dos precisos) → no se toca", regular.length === 0);
  const pendiente = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "en_espera" }])], new Map([[147, carga({})]]));
  chk("una línea que no está enlazada a ninguna carga → nada", pendiente.length === 0);
  const sinTipo = tiposPorCorregir([factura([{ ...premium, tipo_combustible: null }], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }])], new Map([[147, carga({})]]));
  chk("una línea sin tipo (no es combustible) → nada", sinTipo.length === 0);
}

// ── 3. Lo que SÍ se propone además ──────────────────────────────────────────
{
  const legado = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }])], new Map([[147, carga({ tipo_combustible: "gasolina" })]]));
  chk("«Gasolina» a secas (legado) → la factura dice cuál: premium", legado.length === 1 && legado[0].tipo_factura === "gasolina_premium");
  const nulo = tiposPorCorregir([factura([premium], [{ n: 1, codigo: "registrar", combustible_id: 147 }])], new Map([[147, carga({ tipo_combustible: null })]]));
  chk("carga sin tipo (se pintaba como diésel) → se propone, también si la registró la factura", nulo.length === 1 && nulo[0].tipo_carga === null);
  const dos = tiposPorCorregir([
    factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }], 1),
    factura([premium], [{ n: 1, codigo: "ya_registrada", casa_con: 147 }], 2),
  ], new Map([[147, carga({})]]));
  chk("una carga enlazada desde dos facturas sale UNA vez", dos.length === 1);
  const diesel = tiposPorCorregir([factura([{ n: 1, tipo_combustible: "diesel", cantidad: 10.531, total: 260.33 }], [{ n: 1, codigo: "ya_registrada", casa_con: 9 }])],
    new Map([[9, carga({ id: 9, tipo_combustible: "glp", galones: 10.53, total: 260.33 })]]));
  chk("diésel mal rotulado GLP → se propone (galones dentro de la tolerancia)", diesel.length === 1);
}

// ── 4. tipoDistinto ──────────────────────────────────────────────────────────
chk("glp vs premium → distinto", tipoDistinto("glp", "gasolina_premium"));
chk("premium vs premium → igual", !tipoDistinto("gasolina_premium", "gasolina_premium"));
chk("legado gasolina vs regular → distinto", tipoDistinto("gasolina", "gasolina_regular"));
chk("regular vs legado (la factura no precisa) → no", !tipoDistinto("gasolina_regular", "gasolina"));

// ── 5. El filtro por tipo ────────────────────────────────────────────────────
chk("«Gasolina (todas)» encuentra la premium", coincideTipo("gasolina_premium", "gasolina"));
chk("…y la regular", coincideTipo("gasolina_regular", "gasolina"));
chk("…y la vieja sin octanaje", coincideTipo("gasolina", "gasolina"));
chk("…pero no el GLP", !coincideTipo("glp", "gasolina"));
chk("«Gasolina premium» NO trae la regular", !coincideTipo("gasolina_regular", "gasolina_premium"));
chk("«Diésel» sigue exacto, y una carga sin tipo cuenta como diésel", coincideTipo("diesel", "diesel") && coincideTipo(null, "diesel") && !coincideTipo("glp", "diesel"));
chk("«todos» pasa todo", coincideTipo("urea", "todos") && coincideTipo(null, "todos"));

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
