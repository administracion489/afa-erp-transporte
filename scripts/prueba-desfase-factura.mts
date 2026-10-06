// Pruebas del DESFASE entre el despacho y la emisión de la factura de combustible. NO tocan la
// base: datos en memoria contra lib/combustible/desfase-factura.ts y factura-lineas.ts (puros).
// Uso:  npx tsx scripts/prueba-desfase-factura.mts   (sale con código 1 si algo falla)
//
// LO REPORTADO: «las facturas de COESTI llegan 1 día después del despacho». La factura no trae la
// fecha del despacho (F882-0132184: emitida el 04/10 03:18 por un despacho del 03/10 21:55), así
// que la carga que registraba una factura de UNA línea quedaba con la fecha de emisión. Fija:
//
//   1. la medición cuenta bien y desempata hacia el desfase MENOR (mueve menos);
//   2. la decisión: fijo manda; automático solo con evidencia suficiente y constante;
//   3. el origen de la fecha: solo la deducida de la emisión es corrible (y las viejas se infieren
//      con la MISMA regla con que se escriben);
//   4. el caso real de punta a punta (XML → línea → plan), con el algoritmo viejo reproduciendo el bug;
//   5. el cruce busca alrededor de las DOS fechas: nada que ya esté registrado se registra otra vez;
//   6. qué cargas viejas se proponen mover, y cuáles NO;
//   7. invariantes por barrido;
//   8. la factura generada DESPUÉS de su fecha (el cierre de mes) se reconoce y no se corre;
//   9. la medición por cruce con los vouchers, sobre las 35 facturas reales de COESTI;
//  10. las consolidadas se fechan solo con SU evidencia (y nunca por el desfase fijo);
//  11. la decisión de una persona queda GUARDADA: una consolidada llega a «conciliada».
import {
  medirDesfase, decidirDesfase, normalizarDesfaseConfig, origenFechaLinea, fechaDeDespacho, lineasAlDespacho,
  cargasPorMover, resumenMover, sumarDias, diasEntre, esCargaDelRadar, textoMedicion,
  generadaDespues, diaLima, muestrasDesfase, decidirConsolidadas, decidirDesfaseCuenta,
  MIN_MUESTRAS_DESFASE, MIN_ACUERDO_DESFASE, MAX_DESFASE,
  type FacturaRegistrada, type CargaActual, type OrigenFecha, type FacturaParaMedir, type VoucherRadar,
} from "../lib/combustible/desfase-factura";
import {
  lineasUbl, completarConDocumento, planDeLinea, observacionCargaDeFactura, esCargaDeFactura, lineasConDecision,
  type LineaFactura, type CargaExistente,
} from "../lib/combustible/factura-lineas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── 1. La medición ───────────────────────────────────────────────────────────
console.log("\n1. Cuántos días después del despacho sale la factura (medido)");
{
  const m = medirDesfase([1, 1, 1, 0, 1, 2, 1]);
  chk("histograma 0..3", m.histograma.join() === "1,5,1,0", m.histograma.join());
  chk("dominante = el más frecuente", m.dominante === 1 && m.muestras === 7);
  chk("acuerdo = su parte", Math.abs((m.acuerdo ?? 0) - 5 / 7) < 1e-9);
  const empate = medirDesfase([0, 0, 1, 1]);
  chk("a igualdad gana el MENOR (mueve menos: el lado seguro)", empate.dominante === 0);
  const raros = medirDesfase([-1, 4, 9, 1.5, Number.NaN, 1]);
  chk("despacho DESPUÉS de la factura, o a más de 3 días, o no entero: no votan", raros.fuera === 5 && raros.muestras === 1, `fuera ${raros.fuera}`);
  chk("sin muestras: sin dominante", medirDesfase([]).dominante === null && medirDesfase([]).acuerdo === null);
  const frase = textoMedicion(medirDesfase([1, 1, 1, 0]));
  chk("la evidencia se dice en una frase, lo más frecuente primero", /4 recarga\(s\).*3 se facturaron al día siguiente, 1 se facturó el mismo día/.test(frase), frase);
}

// ── 2. La decisión ───────────────────────────────────────────────────────────
console.log("\n2. Qué desfase se aplica, y por qué");
{
  const solido = medirDesfase([...Array(37).fill(1), 0, 0, 0]);
  const d = decidirDesfase(null, solido);
  chk("automático con evidencia sólida → se aplica el medido", d.codigo === "medido" && d.dias === 1, `${d.codigo} ${d.dias}`);
  chk("…y la frase dice con cuántas", d.detalle.includes("40 recarga"), d.detalle);
  for (const k of [0, 1, 2, 3]) {
    const f = decidirDesfase(k, solido);
    chk(`fijo ${k} manda sobre lo medido`, f.codigo === "fijo" && f.dias === k && f.configurado === k);
  }
  chk("un valor desconocido cae a AUTOMÁTICO, nunca a un desfase inventado",
    [7, -1, 1.5, "x", "", undefined, null].every((v) => normalizarDesfaseConfig(v) === null && decidirDesfase(v, solido).codigo === "medido"));
  chk("«2» como texto (lo que guarda un <select>) vale 2", normalizarDesfaseConfig("2") === 2);
  const pocas = decidirDesfase(null, medirDesfase(Array(MIN_MUESTRAS_DESFASE - 1).fill(1)));
  chk(`con ${MIN_MUESTRAS_DESFASE - 1} muestras NO se decide: la emisión, como siempre`, pocas.codigo === "pocos_datos" && pocas.dias === 0);
  const justas = decidirDesfase(null, medirDesfase(Array(MIN_MUESTRAS_DESFASE).fill(1)));
  chk(`con ${MIN_MUESTRAS_DESFASE} sí`, justas.codigo === "medido" && justas.dias === 1);
  // 8 a 1 día y 3 a 0 días: 73 % < 80 %.
  const disperso = decidirDesfase(null, medirDesfase([...Array(8).fill(1), 0, 0, 0]));
  chk("desfase NO constante → no se mueve nada y se dice", disperso.codigo === "disperso" && disperso.dias === 0, disperso.detalle);
  const borde = decidirDesfase(null, medirDesfase([...Array(8).fill(1), 0, 0]));
  chk(`con exactamente ${MIN_ACUERDO_DESFASE * 100} % de acuerdo sí se aplica`, borde.codigo === "medido" && borde.dias === 1);
  const mismo = decidirDesfase(null, medirDesfase(Array(20).fill(0)));
  chk("medido en cero → la factura sale el mismo día, no se mueve", mismo.codigo === "medido_sin_desfase" && mismo.dias === 0);
}

// ── 3. De dónde salió la fecha ───────────────────────────────────────────────
console.log("\n3. Solo se corre la fecha DEDUCIDA de la emisión");
{
  const E = "2026-10-04";
  chk("la que trae la línea es «linea»", origenFechaLinea({ fecha: "2026-10-03" }, E, 1) === "linea");
  chk("la guardada manda sobre la inferencia", origenFechaLinea({ fecha: E, fecha_origen: "linea" }, E, 1) === "linea");
  chk("legada: única línea con la fecha de emisión → «emision» (la regla con que se escribió)", origenFechaLinea({ fecha: E }, E, 1) === "emision");
  chk("legada: dos líneas → una fecha igual a la emisión es de la línea", origenFechaLinea({ fecha: E }, E, 2) === "linea");
  chk("sin fecha no hay origen", origenFechaLinea({ fecha: null }, E, 1) === null);
  chk("solo «emision» se corre", (["linea", "manual", null] as (OrigenFecha | null)[]).every((o) => fechaDeDespacho(E, o, 1) === E) && fechaDeDespacho(E, "emision", 1) === "2026-10-03");
  chk("con desfase 0 (o negativo, o no entero) no se mueve", [0, -1, 1.5].every((k) => fechaDeDespacho(E, "emision", k) === E));
  chk("cruza el mes: 01/10 → 30/09", fechaDeDespacho("2026-10-01", "emision", 1) === "2026-09-30");
  chk("cruza el año: 01/01 → 31/12", fechaDeDespacho("2027-01-01", "emision", 1) === "2026-12-31");
  chk("sumarDias / diasEntre con signo", sumarDias("2026-03-01", -1) === "2026-02-28" && diasEntre("2026-10-03", "2026-10-04") === 1 && diasEntre("2026-10-04", "2026-10-03") === -1);
  chk("esCargaDelRadar: sus dos firmas sí; la de la factura y una a mano no",
    esCargaDelRadar("Radar IA · Grupo · ALEX · Comprobante V70S-1") && esCargaDelRadar("Radar IA (manual · tercero) · grupo X") &&
    !esCargaDelRadar(observacionCargaDeFactura("F882-0132184", null)) && !esCargaDelRadar("Cargado en grifo, voucher perdido") && !esCargaDelRadar(null));

  const al = lineasAlDespacho([{ n: 1, fecha: E, tipo_combustible: "diesel" }], E, 1);
  chk("lineasAlDespacho: la de emisión pasa al despacho y deja la emisión como alterna",
    al.lineas[0].fecha === "2026-10-03" && al.lineas[0].fecha_alterna === E && al.origen.get(1) === "emision");
  const man = lineasAlDespacho([{ n: 1, fecha: E, tipo_combustible: "diesel" }], E, 1, { n: 1, fecha: "2026-10-04" });
  chk("una fecha ELEGIDA por una persona no se corre, aunque coincida con la emisión",
    man.lineas[0].fecha === E && man.origen.get(1) === "manual" && man.lineas[0].fecha_alterna === null);
  const sinElegir = lineasAlDespacho([{ n: 1, fecha: E, tipo_combustible: "diesel" }], E, 1, { n: 1, fecha: null });
  chk("confirmar SIN elegir fecha sí usa la del despacho (un solo corrimiento)", sinElegir.lineas[0].fecha === "2026-10-03");
  const varias = lineasAlDespacho([{ n: 1, fecha: null, tipo_combustible: "diesel" }, { n: 2, fecha: null, tipo_combustible: "glp" }], E, 1);
  chk("factura de varias líneas sin fecha: nada que correr", varias.lineas.every((l) => l.fecha === null && l.fecha_alterna === null));
}

// ── 4. El caso real, de punta a punta ────────────────────────────────────────
console.log("\n4. F882-0132184: el XML real de COESTI → la línea → el plan");
const FLOTA = ["CWZ371", "CWQ400", "BUI272"];
// La forma del XML real (sin la firma): ni la línea ni el documento traen la fecha del despacho.
const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><Invoice xmlns:cac="urn:cac" xmlns:cbc="urn:cbc">
<cbc:ID>F882-0132184</cbc:ID><cbc:IssueDate>2026-10-04</cbc:IssueDate><cbc:IssueTime>03:18:09</cbc:IssueTime><cbc:DueDate>2026-10-04</cbc:DueDate>
<cbc:Note languageLocaleID="1000">DOSCIENTOS SESENTA Y NUEVE Y 92/100 SOLES</cbc:Note>
<cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">20127765279</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>COESTI S.A.</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>AFA TOURS PERU S.A.C.</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="PEN">228.75</cbc:LineExtensionAmount><cbc:PayableAmount currencyID="PEN">269.92</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="GLL">11.094</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="PEN">228.75</cbc:LineExtensionAmount>
<cac:PricingReference><cac:AlternativeConditionPrice><cbc:PriceAmount currencyID="PEN">24.3303</cbc:PriceAmount><cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>
<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">41.17</cbc:TaxAmount></cac:TaxTotal>
<cac:Item><cbc:Description>MAX-D DIESEL B5 S50 UV~~~269.92</cbc:Description><cac:AdditionalItemProperty><cbc:Name>Gastos Art. 37 Renta: Número de Placa</cbc:Name><cbc:NameCode>7000</cbc:NameCode><cbc:Value>CWZ371</cbc:Value></cac:AdditionalItemProperty></cac:Item>
<cac:Price><cbc:PriceAmount currencyID="PEN">20.619254</cbc:PriceAmount></cac:Price></cac:InvoiceLine></Invoice>`;
const E = "2026-10-04";
const { lineas: crudas, textoDoc } = lineasUbl(xml, FLOTA);
const L = completarConDocumento(crudas, textoDoc, FLOTA, E);
chk("la línea: CWZ371, diésel, 11.094 gal, S/ 269.92", L.length === 1 && L[0].placa === "CWZ371" && L[0].tipo_combustible === "diesel" && L[0].total === 269.92,
  `${L[0]?.placa} ${L[0]?.tipo_combustible} ${L[0]?.total}`);
chk("sin fecha propia: toma la de EMISIÓN y queda MARCADA así", L[0].fecha === E && L[0].fecha_origen === "emision", `${L[0].fecha} ${L[0].fecha_origen}`);
{
  const conFecha = completarConDocumento([{ ...crudas[0], fecha: "2026-10-03" }], textoDoc, FLOTA, E);
  chk("una línea que SÍ trae fecha queda «linea» y no se corre", conFecha[0].fecha_origen === "linea" &&
    lineasAlDespacho(conFecha, E, 1).lineas[0].fecha === "2026-10-03");
}
const base = { tipoComprobante: "factura", fuente: "xml_ubl" as const, hoy: "2026-10-06", graciaDias: 1, autoRegistrar: true };
const plan = (linea: LineaFactura, registradas: CargaExistente[], documentoId: number | null = null) =>
  planDeLinea({ ...base, linea, registradas, radarPendientes: [], documentoId });
const juzgada = (dias: number) => lineasAlDespacho(L, E, dias).lineas[0] as LineaFactura;
{
  // El algoritmo VIEJO (sin desfase) tiene que reproducir el defecto.
  const viejo = plan(L[0], []);
  chk("REGRESIÓN: sin desfase la carga se registraba con la fecha de EMISIÓN (04/10)", viejo.codigo === "registrar" && viejo.propuesta?.fecha === E, viejo.propuesta?.fecha);
  const nuevo = plan(juzgada(1), []);
  chk("con el desfase medido (1 día) se registra con la del DESPACHO (03/10)", nuevo.codigo === "registrar" && nuevo.propuesta?.fecha === "2026-10-03", nuevo.propuesta?.fecha);
  const radar: CargaExistente = { id: 501, placa: "CWZ371", fecha: "2026-10-03", total: 269.92, cantidad: 11.094, referencia: "Radar IA · Grupo · ALEX" };
  chk("la recarga que el Radar SÍ registró (03/10) casa: no se registra otra", plan(juzgada(1), [radar]).codigo === "ya_registrada");
}

// ── 5. El cruce busca alrededor de las DOS fechas ────────────────────────────
console.log("\n5. Nada que ya esté registrado se registra otra vez");
{
  const deEstaFactura: CargaExistente = { id: 900, placa: "CWZ371", fecha: E, total: 269.92, cantidad: 11.094, documento_compra_id: 77 };
  for (const k of [1, 2, 3]) {
    const p = plan(juzgada(k), [deEstaFactura], 77);
    chk(`la carga que ESTA factura registró antes con la emisión se sigue encontrando (desfase ${k})`, p.codigo === "ya_registrada", p.codigo);
  }
  // Sin la fecha alterna (solo la ventana alrededor del despacho), con desfase 2 se registraría otra
  // vez una carga tecleada a mano desde la factura con su fecha de emisión (no enlazada a ella).
  const aMano: CargaExistente = { id: 901, placa: "CWZ371", fecha: E, total: 269.92, cantidad: 11.094 };
  const sinAlterna = plan({ ...juzgada(2), fecha_alterna: null }, [aMano], 77);
  chk("REGRESIÓN: sin buscar también alrededor de la emisión, con desfase 2 la registraría DOS veces", sinAlterna.codigo === "registrar");
  chk("…con la alterna se encuentra", plan(juzgada(2), [aMano], 77).codigo === "ya_registrada");
  // La que ESTA factura registró (enlazada a su documento) se reconoce por el enlace, tenga la fecha que tenga.
  const lejos: CargaExistente = { ...deEstaFactura, fecha: "2026-09-20" };
  const porDoc = plan({ ...juzgada(2), fecha_alterna: null }, [lejos], 77);
  chk("una carga YA ENLAZADA a esta factura (misma placa e importe) es esta línea aunque su fecha esté lejos",
    porDoc.codigo === "ya_registrada" && porDoc.por === "documento", `${porDoc.codigo} ${porDoc.por}`);
  chk("…pero enlazada a OTRA factura no", plan({ ...juzgada(2), fecha_alterna: null }, [{ ...lejos, documento_compra_id: 78 }], 77).codigo === "registrar");
  chk("…ni con otro importe", plan({ ...juzgada(2), fecha_alterna: null }, [{ ...lejos, total: 200 }], 77).codigo === "registrar");
  chk("…y con DOS así el enlace no decide (sigue la ventana de fechas)",
    plan({ ...juzgada(2), fecha_alterna: null }, [lejos, { ...lejos, id: 902 }], 77).codigo === "registrar");
  // Un despacho de verdad 2 días antes (el Radar lo tiene): con la ventana vieja (solo la emisión) no se veía.
  const radarDosAntes: CargaExistente = { id: 502, placa: "CWZ371", fecha: "2026-10-02", total: 269.92, cantidad: 11.094 };
  chk("REGRESIÓN: con la fecha de emisión, un despacho de 2 días antes no se encontraba (se duplicaba)", plan(L[0], [radarDosAntes]).codigo === "registrar");
  chk("con el desfase de 1 día se encuentra", plan(juzgada(1), [radarDosAntes]).codigo === "ya_registrada");
  // Ventana: para cada desfase aplicado k y cada desfase VERDADERO t (dónde está la carga del Radar).
  let roto = 0, casos = 0;
  for (let k = 0; k <= MAX_DESFASE; k++) {
    for (let t = 0; t <= MAX_DESFASE + 1; t++) {
      casos++;
      const carga: CargaExistente = { id: 600, placa: "CWZ371", fecha: sumarDias(E, -t), total: 269.92, cantidad: 11.094 };
      const p = plan(juzgada(k), [carga]);
      const debe = Math.abs(t - k) <= 1 || t <= 1; // alrededor del despacho estimado, o de la emisión
      if ((p.codigo === "ya_registrada") !== debe) roto++;
    }
  }
  chk(`barrido (${casos}): se encuentra exactamente lo que cae a ±1 día del despacho estimado o de la emisión`, roto === 0, String(roto));
}

// ── 6. Las cargas viejas por mover ───────────────────────────────────────────
console.log("\n6. Qué cargas registradas con la fecha de emisión se proponen mover");
{
  const fac = (id: number, emision: string, extra: Partial<FacturaRegistrada> = {}): FacturaRegistrada => ({
    factura_id: id, serie: "F882", numero: String(130000 + id), fecha_emision: emision,
    lineas: [{ n: 1, fecha: emision, tipo_combustible: "diesel" }],
    conciliacion: [{ n: 1, codigo: "registrar", combustible_id: id }],
    ...extra,
  });
  const carga = (id: number, fecha: string, obs?: string): CargaActual =>
    ({ id, fecha, observaciones: obs ?? observacionCargaDeFactura(`F882-${130000 + id}`, null), total: 100 + id, placa: "CWZ371" });
  const facturas = [
    fac(1, "2026-10-04"),                                                     // se mueve
    fac(2, "2026-10-01"),                                                     // se mueve y cambia de mes
    fac(3, "2026-09-20"),                                                     // ya movida (la carga dice 19)
    fac(4, "2026-09-18"),                                                     // la carga la cambió una persona
    fac(5, "2026-09-15"),                                                     // la carga se borró
    fac(6, "2026-09-14", { lineas: [{ n: 1, fecha: "2026-09-13", fecha_origen: "linea", tipo_combustible: "diesel" }] }), // fecha de la línea
    fac(7, "2026-09-12", { lineas: [{ n: 1, fecha: null, tipo_combustible: "diesel" }, { n: 2, fecha: null, tipo_combustible: "glp" }] }), // varias líneas
    fac(8, "2026-09-11", { conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 8, fecha_origen: "manual" }] }), // la eligió una persona
    fac(9, "2026-09-10", { conciliacion: [{ n: 1, codigo: "ya_registrada", casa_con: 9 }] }), // re-conciliada: ahora «ya registrada» (la suya)
    fac(10, "2026-09-09", { conciliacion: [{ n: 1, codigo: "ya_registrada", casa_con: 510 }] }), // casó con una del RADAR
    fac(11, "2026-09-08"),                                                    // la carga es de OTRA factura (texto)
  ];
  const cargas = new Map<number, CargaActual>([
    [1, carga(1, "2026-10-04")], [2, carga(2, "2026-10-01")], [3, carga(3, "2026-09-19")], [4, carga(4, "2026-09-25")],
    [6, carga(6, "2026-09-14")], [8, carga(8, "2026-09-11")], [9, carga(9, "2026-09-10")],
    [510, { id: 510, fecha: "2026-09-09", observaciones: "Radar IA · Grupo · ALEX", total: 50, placa: "CWZ371" }],
    [11, carga(11, "2026-09-08", observacionCargaDeFactura("F882-999999", null))],
  ]);
  const xs = cargasPorMover(facturas, cargas, 1);
  const ids = xs.map((x) => x.combustible_id).sort((a, b) => a - b);
  chk("se proponen: la de la emisión, la que cambia de mes y la re-conciliada", ids.join() === "1,2,9", ids.join());
  chk("…NO: ya movida, cambiada a mano, borrada, fecha de la línea, varias líneas, elegida por una persona, del Radar, de otra factura",
    !ids.some((i) => [3, 4, 5, 6, 7, 8, 10, 510, 11].includes(i)));
  const dos = xs.find((x) => x.combustible_id === 2);
  chk("01/10 → 30/09, y lo dice: cambia de mes", dos?.hacia === "2026-09-30" && dos?.cruza_mes === true);
  chk("04/10 → 03/10, mismo mes", xs.find((x) => x.combustible_id === 1)?.hacia === "2026-10-03" && !xs.find((x) => x.combustible_id === 1)?.cruza_mes);
  chk("con desfase 0 no se propone nada", cargasPorMover(facturas, cargas, 0).length === 0);
  chk("con desfase 2 se mueven 2 días", cargasPorMover(facturas, cargas, 2).find((x) => x.combustible_id === 1)?.hacia === "2026-10-02");
  const r = resumenMover(xs);
  chk("resumen: cuántas, por cuánto, desde/hasta y cuántas cambian de mes",
    r.cargas === 3 && r.total === 101 + 102 + 109 && r.desde === "2026-09-10" && r.hasta === "2026-10-04" && r.cruzan_mes === 1, JSON.stringify(r));
  chk("la nota que lleva la carga movida sigue siendo una carga de factura", esCargaDeFactura(`${observacionCargaDeFactura("F882-1", null)} · Fecha del despacho: emitida el 04/10/2026, 1 día(s) antes`));
}

// ── 7. Invariantes por barrido ───────────────────────────────────────────────
console.log("\n7. Barridos");
{
  // fechaDeDespacho: nunca mueve lo que no es de la emisión, nunca hacia adelante, exactamente k días.
  let casos = 0, roto = 0;
  const fechas = ["2026-01-01", "2026-03-01", "2026-10-01", "2026-10-04", "2026-12-31", "2028-03-01"];
  for (const f of fechas) for (const o of ["linea", "emision", "manual", null] as (OrigenFecha | null)[]) for (const k of [-2, -1, 0, 1, 2, 3, 4, 1.5]) {
    casos++;
    const r = fechaDeDespacho(f, o, k)!;
    const d = diasEntre(r, f);
    const aplica = o === "emision" && Number.isInteger(k) && k > 0;
    if (aplica ? d !== k : r !== f) roto++;
    if (d < 0) roto++;
  }
  chk(`fechaDeDespacho (${casos}): solo la de emisión, nunca hacia adelante, exactamente k días`, roto === 0, String(roto));

  // decidirDesfase sobre histogramas: dias > 0 solo en fijo o medido; automático nunca con poca o dispersa evidencia.
  let dec = 0, mal = 0, aplicadas = 0;
  for (let a = 0; a <= 10; a++) for (let b = 0; b <= 10; b++) for (let c = 0; c <= 4; c++) for (const conf of [null, 0, 1, 2]) {
    dec++;
    const m = medirDesfase([...Array(a).fill(0), ...Array(b).fill(1), ...Array(c).fill(2)]);
    const d = decidirDesfase(conf, m);
    if (d.dias > 0 && d.codigo !== "fijo" && d.codigo !== "medido") mal++;
    if (conf == null && d.dias > 0 && (m.muestras < MIN_MUESTRAS_DESFASE || (m.acuerdo ?? 0) < MIN_ACUERDO_DESFASE)) mal++;
    if (d.codigo === "medido" && d.dias !== m.dominante) mal++;
    if (conf != null && d.dias !== conf) mal++;
    if (conf == null && d.codigo === "medido") aplicadas++;
  }
  chk(`decidirDesfase (${dec}): solo corre fechas con evidencia o por configuración`, mal === 0, String(mal));
  chk("y el barrido sí aplica (un motor que nunca moviera cumpliría lo de arriba)", aplicadas > 0, String(aplicadas));

  // Ninguna carga ya registrada —por el Radar en la fecha VERDADERA, o por esta factura con la de
  // emisión— termina en «registrar», sea cual sea el desfase aplicado, si el verdadero está a ±1 del aplicado.
  let barridos = 0, duplicadas = 0;
  for (let k = 0; k <= MAX_DESFASE; k++) for (let t = 0; t <= MAX_DESFASE; t++) for (const quien of ["radar", "factura"] as const) {
    if (Math.abs(t - k) > 1 && quien === "radar") continue;
    barridos++;
    const carga: CargaExistente = quien === "radar"
      ? { id: 1, placa: "CWZ371", fecha: sumarDias(E, -t), total: 269.92, cantidad: 11.094 }
      : { id: 2, placa: "CWZ371", fecha: E, total: 269.92, cantidad: 11.094, documento_compra_id: 77 };
    if (plan(juzgada(k), [carga], 77).codigo === "registrar") duplicadas++;
  }
  chk(`(${barridos}) nunca se registra otra vez lo que ya está: ni lo del Radar ni lo que esta factura registró con la emisión`, duplicadas === 0, String(duplicadas));
}

// ── Las 35 facturas reales de COESTI (23/07–04/10/2026), leídas del correo con su CDR ────────
// [comprobante, fecha de emisión, llegada del correo (hora Lima), líneas: placa · tipo · cantidad · total]
type Real = [string, string, string, [string, string, number, number][]];
const REALES: Real[] = [
  ["F882-0088376", "2026-07-23", "2026-07-23T05:32", [["CWZ371", "diesel", 15.708, 360.03], ["CWQ400", "glp", 11.389, 85.99]]],
  ["F882-0088983", "2026-07-26", "2026-07-26T05:31", [["CWZ371", "diesel", 8.297, 195.06], ["CWQ400", "glp", 9.626, 70.75]]],
  ["F882-0091186", "2026-07-30", "2026-07-30T05:31", [["CWZ371", "diesel", 9.06, 220.07]]],
  ["F882-0091447", "2026-07-31", "2026-07-31T05:48", [["CWQ400", "glp", 10.074, 74.04]]],
  ["F882-0092457", "2026-07-31", "2026-08-01T16:20", [["CWQ400", "gasolina_premium", 5.208, 106.71], ["CWQ400", "glp", 3.511, 24.19]]],
  ["F882-0094809", "2026-08-02", "2026-08-02T05:31", [["CWZ371", "diesel", 10.105, 249.19]]],
  ["F882-0096012", "2026-08-05", "2026-08-05T05:31", [["CWQ400", "glp", 10.001, 74.51]]],
  ["F882-0096243", "2026-08-06", "2026-08-06T05:31", [["CWZ371", "diesel", 9.773, 246.67]]],
  ["F882-0098865", "2026-08-11", "2026-08-11T07:04", [["CWQ400", "glp", 10.72, 74.93]]],
  ["F882-0099238", "2026-08-12", "2026-08-12T05:52", [["CWZ371", "diesel", 13.843, 341.92]]],
  ["F882-0099616", "2026-08-14", "2026-08-14T06:34", [["CWQ400", "glp", 8.829, 61.71]]],
  ["F882-0100048", "2026-08-15", "2026-08-15T08:26", [["CWZ371", "diesel", 9.072, 224.08]]],
  ["F882-0103511", "2026-08-18", "2026-08-18T06:22", [["CWQ400", "glp", 8.13, 56.83]]],
  ["F882-0103832", "2026-08-19", "2026-08-19T07:32", [["CWZ371", "diesel", 9.789, 242.08]]],
  ["F882-0104213", "2026-08-21", "2026-08-21T07:17", [["CWQ400", "glp", 8.136, 55.73]]],
  ["F882-0104658", "2026-08-22", "2026-08-22T07:33", [["CWZ371", "diesel", 9.718, 240.33]]],
  ["F882-0106706", "2026-08-25", "2026-08-25T05:32", [["CWQ400", "glp", 0.708, 4.78]]],
  ["F882-0107071", "2026-08-26", "2026-08-26T05:46", [["CWZ371", "diesel", 12.719, 327.39]]],
  ["F882-0107246", "2026-08-27", "2026-08-27T05:31", [["CWQ400", "glp", 11.083, 74.81]]],
  ["F882-0107963", "2026-08-29", "2026-08-29T07:35", [["CWZ371", "diesel", 10.618, 273.31]]],
  ["F882-0111461", "2026-08-31", "2026-09-01T13:06", [["CWQ400", "gasolina_premium", 8.288, 185.24], ["CWZ371", "diesel", 7.56, 194.59], ["CWQ400", "glp", 11.485, 86.02]]],
  ["F882-0113633", "2026-09-04", "2026-09-04T05:31", [["CWZ371", "diesel", 8.355, 215.06], ["CWQ400", "glp", 10.106, 76.3]]],
  ["F882-0115754", "2026-09-08", "2026-09-08T08:09", [["CWZ371", "diesel", 9.326, 240.05], ["CWQ400", "glp", 9.417, 71.1]]],
  ["F882-0116701", "2026-09-10", "2026-09-10T05:31", [["CWZ371", "diesel", 8.988, 235.04]]],
  ["F882-0116994", "2026-09-11", "2026-09-11T06:01", [["CWQ400", "glp", 8.969, 67.72]]],
  ["F882-0117638", "2026-09-13", "2026-09-13T05:32", [["CWZ371", "diesel", 8.606, 225.05]]],
  ["F882-0119431", "2026-09-15", "2026-09-15T07:19", [["CWQ400", "glp", 8.058, 60.84]]],
  ["F882-0121656", "2026-09-17", "2026-09-17T05:31", [["CWZ371", "diesel", 9.194, 250.08], ["CWQ400", "glp", 9.056, 68.37]]],
  ["F882-0122152", "2026-09-19", "2026-09-19T05:31", [["CWQ400", "glp", 7.507, 56.68]]],
  ["F882-0122454", "2026-09-20", "2026-09-20T12:17", [["CWZ371", "diesel", 9.009, 245.04]]],
  ["F882-0124552", "2026-09-23", "2026-09-23T07:32", [["CWQ400", "glp", 6.266, 47.31]]],
  ["F882-0124794", "2026-09-24", "2026-09-24T21:08", [["CWZ371", "diesel", 12.032, 340.02], ["CWQ400", "glp", 8.304, 62.7]]],
  ["F882-0125628", "2026-09-27", "2026-09-27T05:32", [["CWZ371", "diesel", 8.547, 230.09], ["CWQ400", "glp", 10.777, 81.37]]],
  ["F882-0130996", "2026-09-30", "2026-10-01T19:04", [["CWQ400", "gasolina_premium", 6.388, 152.61], ["CWZ371", "diesel", 12.071, 315.05], ["CWQ400", "glp", 11.293, 85.26]]],
  ["F882-0132184", "2026-10-04", "2026-10-04T05:31", [["CWZ371", "diesel", 11.094, 269.92]]],
];
const aIso = (lima: string) => new Date(`${lima}:00-05:00`).toISOString();
const facturaReal = ([, emision, correo, ls]: Real): FacturaParaMedir => ({
  fecha_emision: emision, recibido_en: aIso(correo),
  lineas: ls.map(([placa, tipo, cantidad, total], i) => ({
    n: i + 1, placa, tipo_combustible: tipo, cantidad, total, ...(ls.length === 1 ? { fecha: emision, fecha_origen: "emision" as const } : { fecha: null }),
  })),
});
const FACTURAS = REALES.map(facturaReal);

// ── 8. El cierre de mes ──────────────────────────────────────────────────────
console.log("\n8. La factura generada DESPUÉS de su fecha (cierre de mes)");
{
  const tardias = REALES.filter((r) => generadaDespues(r[1], aIso(r[2]))).map((r) => r[0]);
  chk("las 3 reales: 31/07, 31/08 y 30/09, generadas el día 1", tardias.join() === "F882-0092457,F882-0111461,F882-0130996", tardias.join());
  chk("F882-0091447 dice 31/07 y salió en el lote del 31/07: NO es tardía (fin de mes no basta)",
    !generadaDespues("2026-07-31", aIso("2026-07-31T05:48")));
  chk("el lote de la madrugada no es tardío (05:31 Lima = 10:31 UTC, el mismo día)", !generadaDespues("2026-10-04", "2026-10-04T10:31:39Z"));
  chk("un correo de las 21:08 Lima (02:08 UTC del día siguiente) sigue siendo del mismo día", !generadaDespues("2026-09-24", "2026-09-25T02:08:19Z"));
  chk("diaLima: 00:04 UTC del 02/10 es el 01/10 en Lima", diaLima("2026-10-02T00:04:40Z") === "2026-10-01");
  chk("sin dato no se afirma nada", !generadaDespues("2026-09-30", null) && !generadaDespues(null, "2026-10-01T12:00:00Z") && !generadaDespues("2026-09-30", "x"));
}

// ── 9. La medición por cruce, sobre las 35 reales ────────────────────────────
console.log("\n9. Cuántos días después factura COESTI, medido contra los vouchers del Radar");
{
  // Los vouchers: el despacho del lote nocturno es el día ANTERIOR a la emisión (lo confirman los tres
  // pares reales de la pantalla del Radar: 22/09 → F882-0124552 del 23/09; 23/09 → F882-0124794 del 24/09).
  const vouchers: VoucherRadar[] = REALES.flatMap((r) => r[3].map(([placa, , cantidad, total]) =>
    ({ placa, fecha: generadaDespues(r[1], aIso(r[2])) ? r[1] : sumarDias(r[1], -1), total, cantidad })));
  const m = muestrasDesfase(FACTURAS, vouchers);
  chk("las 3 del cierre de mes no votan", m.tardias === 3, String(m.tardias));
  chk("25 de una línea, todas al día siguiente", m.una.length === 25 && m.una.every((d) => d === 1), `${m.una.length}: ${[...new Set(m.una)].join()}`);
  chk("14 líneas de 7 consolidadas, todas al día siguiente", m.consolidada.length === 14 && m.consolidada.every((d) => d === 1), `${m.consolidada.length}`);
  const dc = decidirDesfaseCuenta(null, m);
  chk("→ una línea: automático, 1 día", dc.codigo === "medido" && dc.dias === 1, `${dc.codigo} ${dc.dias}`);
  chk("→ consolidadas: se fechan, 1 día", dc.consolidadas.fechar && dc.consolidadas.dias === 1 && dc.consolidadas.codigo === "medido", dc.consolidadas.detalle);
  chk("…y lo dice con su evidencia", /14 recarga\(s\)/.test(dc.consolidadas.detalle) && /emisión − 1/.test(dc.consolidadas.detalle), dc.consolidadas.detalle);

  // REGRESIÓN: lo que medía antes (solo los enlaces de la conciliación de facturas de UNA línea, ±1 día
  // alrededor de la emisión) no veía ninguna consolidada.
  const viejo = FACTURAS.filter((f) => f.lineas.length === 1 && !generadaDespues(f.fecha_emision, f.recibido_en)).length;
  chk("REGRESIÓN: antes las consolidadas no daban ninguna muestra (solo había de una línea)", viejo === 25 && m.consolidada.length > 0);

  const L1 = (placa: string, total: number, extra: Partial<FacturaParaMedir["lineas"][number]> = {}) =>
    ({ n: 1, placa, total, cantidad: 10, tipo_combustible: "diesel", fecha: "2026-10-04", fecha_origen: "emision" as const, ...extra });
  const f1 = (l = L1("CWZ371", 269.92)): FacturaParaMedir => ({ fecha_emision: "2026-10-04", recibido_en: "2026-10-04T10:31:00Z", lineas: [l] });
  const v = (fecha: string, total = 269.92, placa = "CWZ-371", cantidad: number | null = 10): VoucherRadar => ({ placa, fecha, total, cantidad });
  chk("la placa se compara sin guion", muestrasDesfase([f1()], [v("2026-10-03")]).una.join() === "1");
  chk("otra placa no casa", muestrasDesfase([f1()], [v("2026-10-03", 269.92, "BUI272")]).una.length === 0);
  chk("un sol de diferencia ya no casa", muestrasDesfase([f1()], [v("2026-10-03", 268.92)]).una.length === 0);
  chk("90 céntimos sí", muestrasDesfase([f1()], [v("2026-10-03", 269.02)]).una.join() === "1");
  chk(`ventana: de ${MAX_DESFASE} días antes de la emisión al día siguiente`,
    muestrasDesfase([f1()], [v(sumarDias("2026-10-04", -MAX_DESFASE))]).una.join() === String(MAX_DESFASE) &&
    muestrasDesfase([f1()], [v(sumarDias("2026-10-04", -MAX_DESFASE - 1))]).una.length === 0 &&
    muestrasDesfase([f1()], [v("2026-10-05")]).una.join() === "-1" && muestrasDesfase([f1()], [v("2026-10-06")]).una.length === 0);
  chk("dos vouchers con el mismo importe: no cuenta", muestrasDesfase([f1()], [v("2026-10-03"), v("2026-10-02")]).una.length === 0);
  chk("…salvo que la cantidad desempate", muestrasDesfase([f1()], [v("2026-10-03"), v("2026-10-02", 269.92, "CWZ371", 11)]).una.join() === "1");
  chk("un voucher que casa con DOS líneas no cuenta para ninguna", muestrasDesfase([f1(), f1()], [v("2026-10-03")]).una.length === 0);
  chk("una línea que trae SU fecha no vota (el desfase no es para ella)",
    muestrasDesfase([f1(L1("CWZ371", 269.92, { fecha: "2026-10-03", fecha_origen: "linea" }))], [v("2026-10-03")]).una.length === 0);
  chk("la que eligió una persona sí vota (se mide con el voucher, no con su fecha)",
    muestrasDesfase([f1(L1("CWZ371", 269.92, { fecha: "2026-10-01", fecha_origen: "manual" }))], [v("2026-10-03")]).una.join() === "1");
  chk("sin fecha de emisión no hay muestra", muestrasDesfase([{ ...f1(), fecha_emision: null }], [v("2026-10-03")]).una.length === 0);
  chk("un voucher sin fecha o sin importe no sirve", muestrasDesfase([f1()], [{ ...v("2026-10-03"), fecha: null }, { ...v("2026-10-03"), total: null }]).una.length === 0);
}

// ── 10. Las consolidadas se fechan solo con SU evidencia ─────────────────────
console.log("\n10. Las facturas de varias cargas");
{
  const sol = medirDesfase(Array(16).fill(1));
  chk("sin muestras suficientes: a mano", !decidirConsolidadas(medirDesfase(Array(MIN_MUESTRAS_DESFASE - 1).fill(1))).fechar &&
    decidirConsolidadas(medirDesfase(Array(MIN_MUESTRAS_DESFASE - 1).fill(1))).codigo === "pocos_datos");
  chk("dispersas (un mes consolidado no junta UN día): a mano",
    decidirConsolidadas(medirDesfase([...Array(8).fill(1), 0, 2, 3])).codigo === "disperso" && !decidirConsolidadas(medirDesfase([...Array(8).fill(1), 0, 2, 3])).fechar);
  chk("sólidas en 0: se fechan con la emisión (también es una decisión)", decidirConsolidadas(medirDesfase(Array(10).fill(0))).fechar && decidirConsolidadas(medirDesfase(Array(10).fill(0))).dias === 0);
  for (const conf of [0, 1, 2, 3]) {
    const d = decidirDesfaseCuenta(conf, { una: Array(20).fill(1), consolidada: [], tardias: 0 });
    chk(`el desfase FIJO (${conf}) manda en las de una línea y NO fecha las consolidadas sin evidencia`, d.dias === conf && !d.consolidadas.fechar);
  }
  chk("con evidencia de las consolidadas, el fijo no las cambia", decidirDesfaseCuenta(0, { una: [], consolidada: Array(16).fill(1), tardias: 0 }).consolidadas.dias === 1);

  const E2 = "2026-09-24";
  const dos = [
    { n: 1, fecha: null, tipo_combustible: "diesel" }, { n: 2, fecha: null, tipo_combustible: "glp" },
  ];
  const a = lineasAlDespacho(dos, E2, 1, null, { consolidada: 1 });
  chk("consolidada con 1 día: sus dos líneas al 23/09, origen «consolidada», con la emisión de alterna",
    a.lineas.every((l) => l.fecha === "2026-09-23" && l.fecha_alterna === E2) && [...a.origen.values()].every((o) => o === "consolidada"));
  const cero = lineasAlDespacho(dos, E2, 1, null, { consolidada: 0 });
  chk("con 0 días: la de emisión, sin alterna", cero.lineas.every((l) => l.fecha === E2 && l.fecha_alterna === null) && cero.origen.get(1) === "consolidada");
  chk("sin evidencia (null): sin fecha, como antes", lineasAlDespacho(dos, E2, 1, null, { consolidada: null }).lineas.every((l) => l.fecha === null));
  chk("de un cierre de mes: sin fecha (puede juntar varios días)", lineasAlDespacho(dos, E2, 1, null, { consolidada: 1, tardia: true }).lineas.every((l) => l.fecha === null));
  chk("de un cierre de mes, la de UNA línea no se corre", lineasAlDespacho([{ n: 1, fecha: E2, tipo_combustible: "diesel" }], E2, 1, null, { tardia: true }).lineas[0].fecha === E2);
  chk("la consolidada no toca a la de una línea", lineasAlDespacho([{ n: 1, fecha: E2, tipo_combustible: "diesel" }], E2, 2, null, { consolidada: 0 }).lineas[0].fecha === "2026-09-22");
  const conLub = lineasAlDespacho([{ n: 1, fecha: null, tipo_combustible: "diesel" }, { n: 2, fecha: null, tipo_combustible: "glp" }, { n: 3, fecha: null, tipo_combustible: null }], E2, 1, null, { consolidada: 1 });
  chk("una línea que no es combustible no recibe fecha", conLub.lineas[2].fecha === null && conLub.lineas[0].fecha === "2026-09-23");
  const man = lineasAlDespacho(dos, E2, 1, { n: 2, fecha: "2026-09-20" }, { consolidada: 1 });
  chk("la que elige una persona manda sobre la deducida", man.lineas[1].fecha === "2026-09-20" && man.origen.get(2) === "manual" && man.lineas[0].fecha === "2026-09-23");
  chk("una consolidada nunca se propone en «Moverlas» (no es «emision»)", cargasPorMover([{
    factura_id: 1, serie: "F882", numero: "1", fecha_emision: E2, lineas: dos,
    conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 1, fecha_origen: "consolidada" }],
  }], new Map([[1, { id: 1, fecha: E2, observaciones: observacionCargaDeFactura("F882-1", null), total: 1, placa: "CWZ371" }]]), 1).length === 0);
  chk("una de UNA línea de un cierre de mes tampoco se propone", cargasPorMover([{
    factura_id: 2, serie: "F882", numero: "2", fecha_emision: "2026-09-30", recibido_en: aIso("2026-10-01T19:04"),
    lineas: [{ n: 1, fecha: "2026-09-30", tipo_combustible: "diesel" }], conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 2 }],
  }], new Map([[2, { id: 2, fecha: "2026-09-30", observaciones: observacionCargaDeFactura("F882-2", null), total: 1, placa: "CWZ371" }]]), 1).length === 0);

  // De punta a punta: F882-0124794 (24/09, dos cargas) contra lo que el Radar sí tiene del 23/09.
  const f = FACTURAS.find((x, i) => REALES[i][0] === "F882-0124794")!;
  const ls = lineasAlDespacho(f.lineas as LineaFactura[], f.fecha_emision, 1, null, { consolidada: 1 }).lineas as LineaFactura[];
  const radar: CargaExistente[] = [
    { id: 71, placa: "CWZ371", fecha: "2026-09-23", total: 340.02, cantidad: 12.032 },
    { id: 72, placa: "CWQ400", fecha: "2026-09-23", total: 62.7, cantidad: 8.304 },
  ];
  const planes = ls.map((l) => planDeLinea({ ...base, linea: l, registradas: radar, radarPendientes: [], documentoId: null }));
  chk("F882-0124794: sus dos líneas casan con las del Radar del 23/09 (antes: «revisar · sin fecha»)",
    planes.every((p) => p.codigo === "ya_registrada"), planes.map((p) => p.codigo).join());
  const antes = (f.lineas as LineaFactura[]).map((l) => planDeLinea({ ...base, linea: l, registradas: radar, radarPendientes: [], documentoId: null }));
  chk("REGRESIÓN: sin fechar las consolidadas quedaban las dos en «revisar · sin fecha»", antes.every((p) => p.codigo === "revisar" && p.motivo === "sin_fecha"));
}

// ── 11. La decisión de una persona queda guardada ────────────────────────────
console.log("\n11. Confirmar a mano una línea de una consolidada");
{
  const E3 = "2026-09-24";
  const guardadas: LineaFactura[] = [
    { n: 1, descripcion: "MAX-D", cantidad: 12.032, unidad_codigo: "GLL", precio_unitario: 28.26, total: 340.02, tipo_combustible: "diesel", placa: "CWZ371", fecha: null, nota_despacho: null },
    { n: 2, descripcion: "GLP-G", cantidad: 8.304, unidad_codigo: "GLL", precio_unitario: 7.55, total: 62.7, tipo_combustible: "glp", placa: "CWQ400", fecha: null, nota_despacho: null },
  ];
  chk("lineasConDecision: guarda la fecha como «manual» y la placa, solo en esa línea", (() => {
    const r = lineasConDecision(guardadas, { n: 2, fecha: "2026-09-23", placa: "cwq-400" })!;
    return r[1].fecha === "2026-09-23" && r[1].fecha_origen === "manual" && r[1].placa === "CWQ400" && r[0] === guardadas[0];
  })());
  chk("sin nada que cambiar devuelve null (no se escribe)", lineasConDecision(guardadas, { n: 1, placa: "CWZ371" }) === null);
  chk("una fecha mal formada no se guarda", lineasConDecision(guardadas, { n: 1, fecha: "23/09/2026" }) === null);

  // El ciclo: confirmar la 1, después la 2. Antes cada confirmación deshacía la anterior.
  const doc = 77;
  const registradas: CargaExistente[] = [];
  const conciliar = (lineas: LineaFactura[], manual: { n: number; fecha: string } | null, conMejoras: boolean) => {
    const al = lineasAlDespacho(lineas, E3, 1, manual).lineas as LineaFactura[];
    return al.map((l) => {
      const p = planDeLinea({ ...base, linea: l, registradas: registradas.slice(), radarPendientes: [], documentoId: conMejoras ? doc : null });
      if (p.codigo === "registrar" && p.propuesta) {
        registradas.push({ id: 100 + l.n, placa: p.propuesta.placa, fecha: p.propuesta.fecha, total: l.total, cantidad: l.cantidad, documento_compra_id: conMejoras ? doc : null });
      }
      return p;
    });
  };
  // VIEJO: sin guardar la decisión (ni el enlace a la factura).
  let viejo = guardadas;
  conciliar(viejo, { n: 1, fecha: "2026-09-23" }, false);
  const vuelta = conciliar(viejo, { n: 2, fecha: "2026-09-23" }, false);
  chk("REGRESIÓN: al confirmar la 2, la 1 (ya registrada) vuelve a «revisar · sin fecha»", vuelta[0].codigo === "revisar" && vuelta[0].motivo === "sin_fecha");
  // NUEVO: la decisión se guarda en la línea y la carga se reconoce por el enlace.
  registradas.length = 0;
  let lineas = guardadas;
  const p1 = conciliar(lineas, { n: 1, fecha: "2026-09-23" }, true);
  lineas = lineasConDecision(lineas, { n: 1, fecha: "2026-09-23" }) ?? lineas;
  const p2 = conciliar(lineas, { n: 2, fecha: "2026-09-23" }, true);
  lineas = lineasConDecision(lineas, { n: 2, fecha: "2026-09-23" }) ?? lineas;
  const p3 = conciliar(lineas, null, true);
  chk("confirmar la 1 la registra", p1[0].codigo === "registrar");
  chk("al confirmar la 2, la 1 sigue resuelta (ya registrada) y la 2 se registra", p2[0].codigo === "ya_registrada" && p2[1].codigo === "registrar", `${p2[0].codigo} ${p2[1].codigo}`);
  chk("la pasada siguiente (el cron) deja las dos resueltas: la factura llega a «conciliada»", p3.every((p) => p.codigo === "ya_registrada"), p3.map((p) => p.codigo).join());
  chk("y no se registró nada dos veces", registradas.length === 2, String(registradas.length));
  chk("la fecha elegida no se corre en la pasada siguiente", (lineasAlDespacho(lineas, E3, 1).lineas[0].fecha) === "2026-09-23");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
