// Pruebas del SALDO de la cuenta de combustible y de la FACTURA del correo como respaldo del
// Radar. NO tocan la base: datos en memoria contra lib/combustible/saldo-cuenta.ts y
// lib/combustible/factura-lineas.ts (puros).
// Uso:  npx tsx scripts/prueba-saldo-combustible.mts   (sale con código 1 si algo falla)
//
// Lo que defienden, y la mitad de los casos existen para el lado que no se puede aflojar:
//   · el saldo ante la duda sale MÁS BAJO (un aviso tarde deja el bus sin cargar);
//   · un aviso por escalón y por ciclo (no uno por hora), y se rearma con un depósito;
//   · la factura JAMÁS registra una carga que ya existe (sería el gasto dos veces), ni una
//     que el Radar tiene en revisión, ni una sin placa/fecha/cuadre.
import {
  calcularSaldo, decidirAviso, perteneceACuenta, grifoCasa, posteriorAlAncla,
  type CuentaCombustible, type Movimiento, type CargaCuenta,
} from "../lib/combustible/saldo-cuenta";
import {
  lineasUbl, completarConDocumento, planDeLinea, placasEnTexto, notasEnTexto, normNota,
  type LineaFactura, type CargaExistente,
} from "../lib/combustible/factura-lineas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const cuenta: CuentaCombustible = {
  id: 1, nombre: "Primax", patrones_grifo: ["PRIMAX", "COESTI"], rucs: ["20127765279"],
  incluye_terceros: false, umbrales: [500, 300],
};

// ── 1. Qué carga sale de la cuenta ───────────────────────────────────────────
console.log("\n1. Pertenencia a la cuenta");
chk("«COESTI S.A.» es de la cuenta", grifoCasa("COESTI S.A.", "COESTI"));
chk("«GRIFO PRIMAX SAN LUIS» es de la cuenta", grifoCasa("GRIFO PRIMAX SAN LUIS", "PRIMAX"));
chk("«PRIMAXIMO» NO (palabra completa, nunca contiene a secas)", !grifoCasa("PRIMAXIMO", "PRIMAX"));
chk("RUC 20127765279 pertenece aunque el nombre venga raro",
  perteneceACuenta({ id: 1, fecha: "2026-10-01", total: 10, grifo: "EST. 1234", ruc_proveedor: "20127765279" }, cuenta));
chk("Repsol NO pertenece", !perteneceACuenta({ id: 1, fecha: "2026-10-01", total: 10, grifo: "REPSOL" }, cuenta));
chk("tercero excluido si la cuenta no los incluye",
  !perteneceACuenta({ id: 1, fecha: "2026-10-01", total: 10, grifo: "COESTI", es_tercero: true }, cuenta));
chk("tercero incluido si la cuenta los incluye",
  perteneceACuenta({ id: 1, fecha: "2026-10-01", total: 10, grifo: "COESTI", es_tercero: true }, { ...cuenta, incluye_terceros: true }));

// ── 2. El saldo ──────────────────────────────────────────────────────────────
console.log("\n2. Saldo derivado");
const lect = (monto: number, fecha: string, creado = `${fecha}T15:00:00Z`, id = 1): Movimiento => ({ id, tipo: "lectura", monto, fecha, creado_en: creado });
const abono = (monto: number, fecha: string, id = 10): Movimiento => ({ id, tipo: "abono", monto, fecha, creado_en: `${fecha}T16:00:00Z` });
const carga = (total: number, fecha: string, creado?: string, grifo = "COESTI S.A."): CargaCuenta => ({ id: Math.random(), fecha, total, grifo, creado_en: creado ?? `${fecha}T20:00:00Z` });

{
  const s = calcularSaldo({ cuenta, movimientos: [], cargas: [carga(100, "2026-10-01")], hoy: "2026-10-05" });
  chk("sin lectura del portal NO se afirma un saldo", s.saldo === null);
}
{
  const s = calcularSaldo({
    cuenta, hoy: "2026-10-05",
    movimientos: [lect(5392.76, "2026-10-05", "2026-10-05T21:06:00Z")],
    cargas: [carga(225.05, "2026-10-04"), carga(235.04, "2026-10-05", "2026-10-05T22:00:00Z")],
  });
  chk("la carga de AYER no cuenta (ya está dentro del portal)", s.nCargas === 1);
  chk("la carga de hoy registrada DESPUÉS de leer sí cuenta", s.saldo === 5157.72, String(s.saldo));
}
{
  const s = calcularSaldo({
    cuenta, hoy: "2026-10-05",
    movimientos: [lect(1000, "2026-10-01"), abono(2000, "2026-10-02")],
    cargas: [carga(200, "2026-10-02"), carga(300, "2026-10-03", undefined, "REPSOL")],
    porConfirmar: [carga(150, "2026-10-04")],
  });
  chk("lectura + abono − cargas de la cuenta − Radar sin confirmar", s.saldo === 1000 + 2000 - 200 - 150, String(s.saldo));
  chk("lo del Radar se publica APARTE", s.porConfirmar === 150 && s.nPorConfirmar === 1);
}
{
  const s = calcularSaldo({
    cuenta, hoy: "2026-10-05",
    movimientos: [lect(1000, "2026-09-01"), abono(500, "2026-09-02"), lect(800, "2026-10-01", "2026-10-01T15:00:00Z", 2)],
    cargas: [carga(400, "2026-09-10")],
  });
  chk("la ÚLTIMA lectura manda: lo anterior deja de contar", s.saldo === 800, String(s.saldo));
}
chk("mismo día sin hora de registro → cuenta (lado seguro)",
  posteriorAlAncla({ id: 1, fecha: "2026-10-05", total: 1, creado_en: null }, lect(1, "2026-10-05")));
{
  const s = calcularSaldo({
    cuenta, hoy: "2026-10-14",
    movimientos: [lect(700, "2026-10-01")],
    cargas: Array.from({ length: 14 }, (_, i) => carga(50, `2026-10-${String(i + 1).padStart(2, "0")}`)),
  });
  chk("ritmo diario sobre 14 días", s.consumoDiario === 50, String(s.consumoDiario));
  chk("días restantes = saldo ÷ ritmo", s.diasRestantes === Math.floor(s.saldo! / 50), `${s.saldo} → ${s.diasRestantes}`);
}

// ── 3. El aviso: uno por escalón y por ciclo ─────────────────────────────────
console.log("\n3. Ciclo de avisos");
{
  let ultimo: number | null = null;
  const pasos: [number, number | null][] = [
    [2000, null], [480, 500], [470, null], [310, null], [290, 300], [250, null], [-5, 0], [-50, null],
    [3000, null], [495, 500],
  ];
  let ok = true;
  const log: string[] = [];
  for (const [saldo, esperado] of pasos) {
    const d = decidirAviso(saldo, [500, 300], ultimo);
    log.push(`${saldo}→${d.avisar}`);
    if (d.avisar !== esperado) ok = false;
    ultimo = d.nuevoUltimo;
  }
  chk("500 → 300 → agotado, sin repetir, y se rearma tras el depósito", ok, log.join(" "));
}
chk("sin umbrales igual avisa el agotamiento", decidirAviso(-1, [], null).avisar === 0);
chk("sin saldo (sin lectura) no avisa nada", decidirAviso(null, [500], null).avisar === null);
chk("saltar de golpe a 200 avisa el 300 (el más bajo cruzado), no el 500", decidirAviso(200, [500, 300], null).avisar === 300);
chk("umbrales desordenados/repetidos/negativos se limpian", decidirAviso(450, ["300", 500, -4, 500], null).avisar === 500);
// Barrido: jamás se avisa dos veces el mismo escalón dentro de un ciclo descendente.
{
  let ok = true;
  for (let a = 1000; a > -100 && ok; a -= 37) {
    let ultimo: number | null = null;
    const avisados: number[] = [];
    for (let s = a; s > -200; s -= 13) {
      const d = decidirAviso(s, [500, 300, 100], ultimo);
      if (d.avisar != null) { if (avisados.includes(d.avisar)) ok = false; avisados.push(d.avisar); }
      ultimo = d.nuevoUltimo;
    }
    // corolario: un motor que nunca avisa cumpliría lo anterior — exigir el agotamiento.
    if (!avisados.includes(0)) ok = false;
  }
  chk("barrido: ningún escalón se repite y el agotamiento siempre se avisa", ok);
}

// ── 4. La factura UBL ────────────────────────────────────────────────────────
console.log("\n4. Lectura de la factura (XML SUNAT)");
const FLOTA = ["CWZ371", "CWQ400", "BUI272", "CTV370"];
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns:cbc="urn:cbc" xmlns:cac="urn:cac">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>F070-00012345</cbc:ID>
  <cbc:IssueDate>2026-10-04</cbc:IssueDate>
  <cbc:InvoiceTypeCode listID="0101">01</cbc:InvoiceTypeCode>
  <cbc:Note><![CDATA[Placa: CWZ-371 Nota de despacho V70S-00043064]]></cbc:Note>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">20127765279</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>COESTI S.A.</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>AFA TOURS PERU S.A.C.</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">34.33</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="PEN">190.72</cbc:LineExtensionAmount><cbc:PayableAmount currencyID="PEN">225.05</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="GLL">8.61</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="PEN">190.72</cbc:LineExtensionAmount>
    <cac:PricingReference><cac:AlternativeConditionPrice><cbc:PriceAmount currencyID="PEN">26.138</cbc:PriceAmount><cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>
    <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">34.33</cbc:TaxAmount></cac:TaxTotal>
    <cac:Item><cbc:Description><![CDATA[MAX-D DIESEL B5 S50 UV]]></cbc:Description></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="PEN">22.151</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
const { lineas, textoDoc } = lineasUbl(xml, FLOTA);
const L = completarConDocumento(lineas, textoDoc, FLOTA, "2026-10-04");
chk("una línea", L.length === 1);
chk("total CON impuestos (base + impuesto de la línea)", L[0].total === 225.05, String(L[0].total));
chk("precio con IGV del PricingReference", L[0].precio_unitario === 26.138);
chk("tipo: diésel por la descripción del producto", L[0].tipo_combustible === "diesel");
chk("placa del documento (una sola, de la flota)", L[0].placa === "CWZ371", String(L[0].placa));
chk("la nota de despacho del documento", L[0].nota_despacho === "V70S-00043064");
chk("fecha de emisión vale solo porque es UNA línea", L[0].fecha === "2026-10-04");
chk("«S50» y «B5» no son placas", placasEnTexto("MAX-D DIESEL B5 S50", FLOTA).length === 0);
chk("«CWZ 371» con espacio sí es la placa", placasEnTexto("UNIDAD CWZ 371", FLOTA)[0] === "CWZ371");
chk("la empresa COMPRADORA no aporta una placa", !placasEnTexto("AFA TOURS PERU S.A.C.", FLOTA).length);
chk("dos placas en el documento → ninguna (no se adivina)",
  completarConDocumento([{ ...L[0], placa: null }], "CWZ371 y BUI272", FLOTA, null)[0].placa === null);
chk("factura de VARIAS líneas: la fecha de emisión NO se hereda",
  completarConDocumento([{ ...L[0], fecha: null }, { ...L[0], n: 2, fecha: null }], "", FLOTA, "2026-10-30").every((l) => l.fecha === null));
chk("nota normalizada sin ceros a la izquierda", normNota("V70S-00043064") === normNota("v70s 43064"));
chk("notas en texto libre", notasEnTexto("Comprobante V72S-00023776 · ok")[0] === "V72S-00023776");

// ── 5. La decisión por línea ─────────────────────────────────────────────────
console.log("\n5. Plan por línea");
const base = {
  tipoComprobante: "factura", fuente: "xml_ubl" as const, hoy: "2026-10-08", graciaDias: 1, autoRegistrar: true,
};
const linea: LineaFactura = L[0];
const reg = (o: Partial<CargaExistente>): CargaExistente => ({ id: 77, placa: "CWZ371", fecha: "2026-10-04", total: 225.05, cantidad: 8.61, ...o });

chk("ya registrada por placa+fecha+importe → se enlaza, no se crea",
  planDeLinea({ ...base, linea, registradas: [reg({})], radarPendientes: [] }).codigo === "ya_registrada");
chk("ya registrada por la NOTA aunque la placa esté mal puesta",
  planDeLinea({ ...base, linea, registradas: [reg({ placa: "BUI272", total: 1, referencia: "Comprobante V70S-00043064" })], radarPendientes: [] }).por === "nota");
chk("ya registrada con la fecha corrida un día",
  planDeLinea({ ...base, linea, registradas: [reg({ fecha: "2026-10-05" })], radarPendientes: [] }).codigo === "ya_registrada");
chk("ya registrada por cantidad aunque el importe se redondeó distinto",
  planDeLinea({ ...base, linea, registradas: [reg({ total: 223.5 })], radarPendientes: [] }).por === "placa_fecha_cantidad");
chk("en revisión del Radar → NO se registra otra",
  planDeLinea({ ...base, linea, registradas: [], radarPendientes: [reg({ id: "uuid" })] }).codigo === "en_radar_pendiente");
chk("dos candidatas iguales → ambigua, no elige",
  planDeLinea({ ...base, linea, registradas: [reg({}), reg({ id: 78 })], radarPendientes: [] }).motivo === "ambigua");
chk("enlazada a OTRA factura no puede ser esta línea → falta",
  planDeLinea({ ...base, linea, registradas: [reg({ documento_compra_id: 5 })], radarPendientes: [] }).codigo === "registrar");
chk("enlazada a ESTA factura sí (reproceso idempotente)",
  planDeLinea({ ...base, linea, documentoId: 5, registradas: [reg({ documento_compra_id: 5 })], radarPendientes: [] }).codigo === "ya_registrada");
{
  const p = planDeLinea({ ...base, linea, registradas: [], radarPendientes: [] });
  chk("no está en ningún lado → registrar", p.codigo === "registrar");
  chk("la propuesta trae unidad y precio con IGV", p.propuesta?.unidad === "galones" && p.propuesta?.precio_galon === 26.14);
}
chk("muy reciente → espera al Radar",
  planDeLinea({ ...base, hoy: "2026-10-04", linea, registradas: [], radarPendientes: [] }).codigo === "en_espera");
chk("solo PDF (IA) → revisar, no se registra solo",
  planDeLinea({ ...base, fuente: "vision_pdf", linea, registradas: [], radarPendientes: [] }).motivo === "lectura_no_oficial");
chk("auto-registro apagado → revisar",
  planDeLinea({ ...base, autoRegistrar: false, linea, registradas: [], radarPendientes: [] }).motivo === "auto_apagado");
chk("sin placa → revisar", planDeLinea({ ...base, linea: { ...linea, placa: null }, registradas: [], radarPendientes: [] }).motivo === "sin_placa");
chk("sin fecha → revisar", planDeLinea({ ...base, linea: { ...linea, fecha: null }, registradas: [], radarPendientes: [] }).motivo === "sin_fecha");
chk("cantidad × precio ≠ total → revisar",
  planDeLinea({ ...base, linea: { ...linea, total: 300 }, registradas: [], radarPendientes: [] }).motivo === "no_cuadra");
chk("nota de crédito → revisar", planDeLinea({ ...base, tipoComprobante: "nota_credito", linea, registradas: [], radarPendientes: [] }).motivo === "nota_credito");
chk("un lubricante no es combustible",
  planDeLinea({ ...base, linea: { ...linea, descripcion: "ACEITE 15W40", tipo_combustible: null }, registradas: [], radarPendientes: [] }).codigo === "no_es_combustible");

// Barrido: JAMÁS se registra una carga cuando hay una registrada (o del Radar) que casa.
{
  let ok = true, registradas = 0;
  const dias = ["2026-10-03", "2026-10-04", "2026-10-05"];
  for (const d of dias) for (const dt of [-0.5, 0, 0.5, 3]) for (const dq of [0, 0.03, 1]) for (const plc of ["CWZ371", "BUI272"])
  for (const conNota of [false, true]) for (const donde of ["reg", "radar"] as const) for (const fuente of ["xml_ubl", "vision_pdf"] as const) {
    const c = reg({ fecha: d, total: 225.05 + dt, cantidad: 8.61 + dq, placa: plc, referencia: conNota ? "V70S-00043064" : "" });
    const casaria = conNota || (plc === "CWZ371" && (Math.abs(dt) < 1 || dq <= 0.05));
    const p = planDeLinea({ ...base, fuente, linea, registradas: donde === "reg" ? [c] : [], radarPendientes: donde === "radar" ? [c] : [] });
    if (casaria && p.codigo === "registrar") ok = false;
    if (p.codigo === "registrar") registradas++;
  }
  chk("barrido: nunca se registra lo que ya casa", ok);
  chk("corolario: el barrido sí registra lo que de verdad falta", registradas > 0, `${registradas} casos`);
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
