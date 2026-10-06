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
//   7. invariantes por barrido.
import {
  medirDesfase, decidirDesfase, normalizarDesfaseConfig, origenFechaLinea, fechaDeDespacho, lineasAlDespacho,
  cargasPorMover, resumenMover, sumarDias, diasEntre, esCargaDelRadar, textoMedicion,
  MIN_MUESTRAS_DESFASE, MIN_ACUERDO_DESFASE, MAX_DESFASE,
  type FacturaRegistrada, type CargaActual, type OrigenFecha,
} from "../lib/combustible/desfase-factura";
import {
  lineasUbl, completarConDocumento, planDeLinea, observacionCargaDeFactura, esCargaDeFactura,
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
  // Sin la fecha alterna (solo la ventana alrededor del despacho), con desfase 2 se registraría otra vez.
  const sinAlterna = plan({ ...juzgada(2), fecha_alterna: null }, [deEstaFactura], 77);
  chk("REGRESIÓN: sin buscar también alrededor de la emisión, con desfase 2 la registraría DOS veces", sinAlterna.codigo === "registrar");
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

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
