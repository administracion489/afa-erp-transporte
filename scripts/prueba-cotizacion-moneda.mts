// Matriz de lib/cotizacion-moneda.ts — npx tsx scripts/prueba-cotizacion-moneda.mts
import {
  normalizarMoneda, revisarTipoCambio, aMonedaCot, aPENdesdeCot, itemsEnMoneda, itemsAPEN,
  totalesEnMoneda, planCambioMoneda, planCambioTipoCambio, sugerirTipoCambio, simboloMoneda, TC_MIN, TC_MAX,
} from "../lib/cotizacion-moneda";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };

// El calcItems VIEJO de app/cotizaciones/page.tsx, copiado literal.
type ItemCot = { descripcion: string; dias: number; cantidad: number; precio_unit: number; descuento_pct: number };
const calcItems=(items:ItemCot[],conIGV=true)=>{const s=items.reduce((t,it)=>t+it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100),0);return{subtotal:s,igv:conIGV?s*0.18:0,total:conIGV?s*1.18:s};};

console.log("1. Ida y vuelta exacta: US$ tecleado → S/ guardado → US$ mostrado");
{
  let n = 0, mal = 0;
  const tcs: number[] = [];
  for (let t = TC_MIN * 10000; t <= TC_MAX * 10000; t += 137) tcs.push(t / 10000);
  tcs.push(3.7512, 3.75, 2.5, 6);
  for (const tc of tcs) {
    for (let c = 1; c <= 200000; c = c < 1000 ? c + 1 : Math.ceil(c * 1.37)) {
      const usd = c / 100; n++;
      const pen = aPENdesdeCot(usd, "USD", tc)!;
      const back = aMonedaCot(pen, "USD", tc)!;
      if (back !== usd) { if (mal < 5) console.log(`    ${usd} @ ${tc} → ${pen} → ${back}`); mal++; }
      if (Math.round(pen * 10000) !== pen * 10000 && Math.abs(Math.round(pen * 10000) - pen * 10000) > 1e-6) mal++;
    }
  }
  ok(mal === 0, `ida y vuelta exacta en ${n} combinaciones (${mal} fallan)`);
}

console.log("2. PEN = calcItems viejo, al bit");
{
  const rnd = (s: number) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const r = rnd(7); let iguales = 0, total = 0;
  for (let k = 0; k < 3000; k++) {
    const items: ItemCot[] = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({
      descripcion: "x", dias: 1 + Math.floor(r() * 30), cantidad: 1 + Math.floor(r() * 4),
      precio_unit: Math.round(r() * 500000) / 100 + (r() < 0.3 ? 1 / 3 : 0), descuento_pct: r() < 0.4 ? Math.floor(r() * 30) : 0,
    }));
    for (const igv of [true, false]) {
      total++;
      const v = calcItems(items, igv), n = totalesEnMoneda(items, "PEN", 3.8, igv)!;
      if (v.subtotal === n.subtotal && v.igv === n.igv && v.total === n.total) iguales++;
    }
  }
  ok(iguales === total, `PEN idéntico a calcItems en ${total} casos (${iguales})`);
  ok(itemsEnMoneda([{ dias: 1, cantidad: 1, precio_unit: 33.3333, descuento_pct: 0 }], "PEN", null)![0].precio_unit === 33.3333, "PEN no redondea el unitario");
  ok(aMonedaCot(1234.5678, "PEN", 999) === 1234.5678, "PEN ignora el TC (incluso uno absurdo)");
  ok(aPENdesdeCot(1234.5678, "PEN", null) === 1234.5678, "PEN → PEN es la identidad");
}

console.log("3. USD cuadra a la vista");
{
  const rnd = (s: number) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const r = rnd(11); let malos = 0, n = 0;
  for (let k = 0; k < 3000; k++) {
    const tc = Math.round((TC_MIN + r() * (TC_MAX - TC_MIN)) * 10000) / 10000;
    const items = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({
      dias: 1 + Math.floor(r() * 30), cantidad: 1 + Math.floor(r() * 4),
      precio_unit: Math.round(r() * 5000000) / 10000, descuento_pct: r() < 0.4 ? Math.floor(r() * 30) : 0,
    }));
    for (const igv of [true, false]) {
      n++;
      const t = totalesEnMoneda(items, "USD", tc, igv)!;
      const c = (x: number) => Math.round(x * 100);
      const sumL = t.lineas.reduce((a, b) => a + c(b), 0);
      const lineasOk = t.lineas.every((l, i) => c(l) === Math.round(items[i].dias * items[i].cantidad * t.unitarios[i] * (1 - items[i].descuento_pct / 100) * 100 + 1e-9 * Math.sign(l)) || Math.abs(l - items[i].dias * items[i].cantidad * t.unitarios[i] * (1 - items[i].descuento_pct / 100)) <= 0.005 + 1e-9);
      if (sumL !== c(t.subtotal) || c(t.subtotal) + c(t.igv) !== c(t.total) || !lineasOk || (!igv && t.igv !== 0)) malos++;
      if (t.unitarios.some(u => c(u) / 100 !== u)) malos++;
    }
  }
  ok(malos === 0, `Σ líneas = subtotal, subtotal + IGV = total, unitarios a céntimos (${n} casos, ${malos} malos)`);
}

console.log("4. USD sin TC válido no se convierte");
{
  for (const tc of [null, undefined, "", "abc", 0, -3, 2.49, 6.01, 375, 0.27]) {
    ok(aMonedaCot(100, "USD", tc) === null, `aMonedaCot USD con TC ${String(tc)} → null`);
    ok(aPENdesdeCot(100, "USD", tc) === null, `aPENdesdeCot USD con TC ${String(tc)} → null`);
    ok(totalesEnMoneda([{ dias: 1, cantidad: 1, precio_unit: 100, descuento_pct: 0 }], "USD", tc) === null, `totales USD con TC ${String(tc)} → null`);
    ok(revisarTipoCambio(tc).codigo !== "ok" && revisarTipoCambio(tc).tc === null, `revisarTipoCambio(${String(tc)}) no es ok`);
  }
  ok(revisarTipoCambio(null).codigo === "falta_tc", "null → falta_tc");
  ok(revisarTipoCambio("abc").codigo === "tc_no_numero", "texto → tc_no_numero");
  ok(revisarTipoCambio(375).codigo === "tc_fuera_de_rango", "375 → tc_fuera_de_rango");
  ok(revisarTipoCambio("3,7512").tc === 3.7512, "acepta coma decimal");
  ok(revisarTipoCambio(3.75).codigo === "ok", "3.75 ok");
  ok(itemsAPEN([{ dias: 1, cantidad: 1, precio_unit: 10, descuento_pct: 0 }], "USD", null) === null, "itemsAPEN sin TC → null");
}

console.log("5. Moneda desconocida → PEN");
for (const v of [null, undefined, "", "pen", "EUR", 3, "dolares", {}]) ok(normalizarMoneda(v) === "PEN", `normalizarMoneda(${JSON.stringify(v)}) = PEN`);
ok(normalizarMoneda("usd") === "USD" && normalizarMoneda(" USD ") === "USD", "usd → USD");
ok(simboloMoneda("PEN") === "S/" && simboloMoneda("USD") === "US$", "símbolos");

console.log("6. Cambiar de moneda nunca cambia los soles");
{
  const items = [{ dias: 2, cantidad: 1, precio_unit: 1234.5678, descuento_pct: 5 }, { dias: 1, cantidad: 3, precio_unit: 99.99, descuento_pct: 0 }];
  const copia = JSON.stringify(items);
  for (const de of ["PEN", "USD"] as const) for (const a of ["PEN", "USD"] as const) for (const tc of [null, 3.75, 375]) {
    const p = planCambioMoneda({ moneda: de, tipoCambio: tc, itemsPEN: items, precioDiaPEN: 500 }, a);
    ok(p.itemsPEN === items && JSON.stringify(p.itemsPEN) === copia && p.precioDiaPEN === 500 && p.moneda === a, `${de}→${a} TC ${tc}: soles intactos`);
    if (de !== a && a === "USD") ok((p.codigo === "a_dolares") === (tc === 3.75), `${de}→USD TC ${tc}: código ${p.codigo}`);
  }
  // Cambiar el TC conserva los US$ tecleados
  const enPantalla = [{ dias: 1, cantidad: 1, precio_unit: 250.4, descuento_pct: 0 }];
  for (const tc of [3.5, 3.75, 3.9871]) {
    const pen = planCambioTipoCambio(enPantalla, "USD", tc)!;
    ok(aMonedaCot(pen[0].precio_unit, "USD", tc) === 250.4, `cambio de TC a ${tc}: US$ 250.40 se conserva`);
  }
}

console.log("7. Corolario: USD da importes distintos de PEN");
{
  const items = [{ dias: 1, cantidad: 1, precio_unit: 1000, descuento_pct: 0 }];
  const p = totalesEnMoneda(items, "PEN", 3.75)!, u = totalesEnMoneda(items, "USD", 3.75)!;
  ok(p.total !== u.total && u.subtotal === 266.67, `S/ 1000 → US$ ${u.subtotal}`);
}

console.log("8. Sugerencia de TC");
{
  ok(sugerirTipoCambio({ filaTabla: { venta: 3.761, fecha: "2026-10-15" }, ultimaCotUsd: { tipo_cambio: 3.7 } }).fuente === "tabla_tipo_cambio", "tabla manda");
  const s2 = sugerirTipoCambio({ filaTabla: { venta: 0 }, ultimaCotUsd: { tipo_cambio: "3.70", numero_cotizacion: "C-1" } });
  ok(s2.fuente === "ultima_cotizacion_usd" && s2.tc === 3.7, "fila inválida → última cotización USD");
  const s3 = sugerirTipoCambio({});
  ok(s3.fuente === "sin_fuente" && s3.tc === null, "sin fuentes → vacío");
  ok(sugerirTipoCambio({ ultimaCotUsd: { tipo_cambio: 375 } }).tc === null, "una fuente fuera de banda no se propone");
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
