// Pruebas de QUÉ FACTURA DEL CORREO respalda una carga (o espera a una recarga del Radar), qué adjunto
// es su documento y cómo se abre su correo (lib/combustible/factura-de-carga.ts, puro). NO tocan la base.
// Uso:  npx tsx scripts/prueba-factura-de-carga.mts   (sale con código 1 si algo falla)
//
// LO PIDIÓ EL DUEÑO sobre el recuadro de fusión del Radar (CWQ400, 18/09, carga #63 que registró una
// factura de COESTI): «aquí falta un link hacia el correo que se leyó, para poder revisar el documento».
// Fija:
//
//   1. el comprobante de una carga: sus columnas fiscales o la marca que escribió la factura (el CICLO:
//      lo que `observacionCargaDeFactura` escribe es lo que se lee);
//   2. qué factura es la de una carga: la que la NOMBRA en su conciliación; si no, la de su
//      comprobante; nunca una que solo se le parece;
//   3. la factura que espera a una recarga del Radar, y el filtro con que se la pide a la base;
//   4. qué adjunto es el documento: el PDF del comprobante, su XML (nunca la CDR), o un PDF suelto; y
//      un «.pdf» que no es un PDF no se enseña como PDF;
//   5. el enlace a Gmail en la cuenta del buzón, no en la primera del navegador;
//   6. el tipo con que se enseña: un XML como TEXTO (abierto como documento correría lo que traiga);
//   7. la instrucción vieja «descarta esta fila» de las recargas procesadas antes de la fusión: con el
//      texto real de la pantalla, se dice lo de hoy.
import {
  referenciaFacturaDeCarga, elegirFacturaDeCarga, elegirFacturaQueEspera, filtroFacturaQueEspera,
  elegirDocumentoFactura, enlaceGmail, tipoParaMostrar, rotuloFactura, fuenteDeLectura,
  type FacturaGuardada,
} from "../lib/combustible/factura-de-carga";
import { observacionCargaDeFactura, referenciaEnObservacion, type LineaFactura } from "../lib/combustible/factura-lineas";
import {
  buscarCargaRegistrada, detalleVigente, INSTRUCCION_FUSIONAR_FACTURA, INSTRUCCION_VIEJA_DESCARTAR,
} from "../lib/radar/album-recargas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const OBS_63 = observacionCargaDeFactura("F882-0124552", "V97T-00001433", null);
const LINEA: LineaFactura = {
  n: 1, descripcion: "GLP-G", cantidad: 7.507, unidad_codigo: "GLL", precio_unitario: 7.55, total: 56.68,
  tipo_combustible: "glp", placa: "CWQ400", fecha: "2026-09-18", nota_despacho: "V97T-00001433",
};
const FAC: FacturaGuardada = {
  id: 501, gmail_message_id: "199a1b2c3d4e5f60", serie: "F882", numero: "0124552", razon_social: "COESTI S.A.",
  ruc_emisor: "20127765279", fecha_emision: "2026-09-19", recibido_en: "2026-09-19T08:21:00Z", total: 56.68,
  fuente_extraccion: "xml_ubl", estado: "conciliada", lineas: [LINEA],
  conciliacion: [{ n: 1, codigo: "registrar", detalle: "", combustible_id: 63 }],
};

// ── 1. El comprobante de una carga ───────────────────────────────────────────
console.log("\n1. El comprobante de una carga");
{
  chk("la marca que escribe la factura se lee igual (el ciclo)", referenciaEnObservacion(OBS_63) === "F882-0124552");
  const r = referenciaFacturaDeCarga({ observaciones: OBS_63 });
  chk("…y se parte en serie y número como los guarda radar_facturas", r?.serie === "F882" && r?.numero === "0124552", JSON.stringify(r));
  const conCols = referenciaFacturaDeCarga({ observaciones: OBS_63, comprobante_serie: " F001 ", comprobante_numero: "77" });
  chk("las columnas fiscales mandan sobre la marca (la conciliación las escribe al enlazar)", conCols?.serie === "F001" && conCols?.numero === "77");
  chk("columnas en blanco: se cae a la marca", referenciaFacturaDeCarga({ observaciones: OBS_63, comprobante_serie: "", comprobante_numero: "  " })?.numero === "0124552");
  chk("una carga del Radar o tecleada, sin comprobante: null", referenciaFacturaDeCarga({ observaciones: "Radar IA · Grupo Combustible · Comprobante V67T-00015555" }) === null);
  chk("la marca sin serie ni número («-») no es un comprobante", referenciaFacturaDeCarga({ observaciones: observacionCargaDeFactura("-", null) }) === null);
  chk("sin nada: null", referenciaFacturaDeCarga({}) === null && referenciaEnObservacion(null) === null);
}

// ── 2. Qué factura es la de una carga ────────────────────────────────────────
console.log("\n2. Qué factura es la de una carga");
{
  const c63 = { id: 63, observaciones: OBS_63 };
  const e = elegirFacturaDeCarga(c63, [FAC]);
  chk("la que la REGISTRÓ, con su línea", e?.factura.id === 501 && e.linea?.n === 1 && e.por === "conciliacion" && e.plan?.codigo === "registrar");
  chk("…y se dice así", e ? rotuloFactura(e) === "La registró la factura" : false);

  const respalda: FacturaGuardada = { ...FAC, id: 502, conciliacion: [{ n: 1, codigo: "ya_registrada", detalle: "", casa_con: 15 }] };
  const e15 = elegirFacturaDeCarga({ id: 15, observaciones: "Radar IA · Comprobante V67T-00015555" }, [respalda]);
  chk("una carga del Radar que la factura ENLAZÓ (ya_registrada): esa factura, con su línea", e15?.factura.id === 502 && e15.linea?.n === 1 && rotuloFactura(e15!) === "La respalda la factura");

  const comoTexto: FacturaGuardada = { ...FAC, id: 503, conciliacion: [{ n: 1, codigo: "registrar", detalle: "", combustible_id: "63" }] };
  chk("el id guardado como texto también la nombra", elegirFacturaDeCarga(c63, [comoTexto])?.factura.id === 503);

  const reenviada: FacturaGuardada = { ...FAC, id: 504, recibido_en: "2026-09-25T10:00:00Z", conciliacion: [] };
  chk("el mismo correo reenviado (dos filas): gana la que NOMBRA a la carga, aunque sea más vieja",
    elegirFacturaDeCarga(c63, [reenviada, FAC])?.factura.id === 501);

  const sinPlan: FacturaGuardada = { ...FAC, id: 505, conciliacion: [] };
  const porComp = elegirFacturaDeCarga(c63, [sinPlan]);
  chk("ninguna la nombra: la de su comprobante, sin línea (no se adivina cuál)", porComp?.factura.id === 505 && porComp.linea === null && porComp.por === "comprobante");

  const otraCarga: FacturaGuardada = { ...FAC, id: 506, serie: "F882", numero: "0999999", conciliacion: [{ n: 1, codigo: "registrar", detalle: "", combustible_id: 64 }] };
  chk("una factura que nombra a OTRA carga, con otro comprobante: no es la suya", elegirFacturaDeCarga(c63, [otraCarga]) === null);
  const parecida: FacturaGuardada = { ...FAC, id: 507, serie: "F882", numero: "0130000", conciliacion: [] };
  chk("misma placa, mismo importe y otro comprobante: NO se elige (no se busca por parecido)", elegirFacturaDeCarga(c63, [parecida]) === null);
  chk("una carga sin comprobante que nadie nombra: null", elegirFacturaDeCarga({ id: 15, observaciones: "Radar IA" }, [parecida, sinPlan]) === null);
  const enRadar: FacturaGuardada = { ...FAC, id: 508, conciliacion: [{ n: 1, codigo: "en_radar_pendiente", detalle: "", casa_con: 63 }] };
  chk("«en_radar_pendiente» con el mismo número NO nombra a la carga #63 (ese casa_con es una fila del Radar)",
    elegirFacturaDeCarga({ id: 63, observaciones: null }, [enRadar]) === null);
}

// ── 3. La factura que espera a una recarga del Radar ─────────────────────────
console.log("\n3. La factura que espera a una recarga del Radar");
{
  const uuid = "4a3c2b1d-0000-4000-8000-1234567890ab";
  const espera: FacturaGuardada = { ...FAC, id: 601, estado: "parcial", conciliacion: [{ n: 1, codigo: "en_radar_pendiente", detalle: "", casa_con: uuid }] };
  const e = elegirFacturaQueEspera(uuid, [espera]);
  chk("la que la espera, con su línea", e?.factura.id === 601 && e.linea?.n === 1 && rotuloFactura(e) === "La espera la factura");
  chk("otra recarga: null", elegirFacturaQueEspera("otra", [espera]) === null);
  chk("una línea que ya se registró no «espera»", elegirFacturaQueEspera(uuid, [{ ...espera, conciliacion: [{ n: 1, codigo: "registrar", detalle: "", combustible_id: 63 }] }]) === null);
  // EL CICLO: el filtro que se le pide a la base está CONTENIDO en lo que la conciliación escribe.
  const filtro = JSON.parse(filtroFacturaQueEspera(uuid))[0];
  const plan = espera.conciliacion![0] as unknown as Record<string, unknown>;
  chk("el filtro de la base es un subconjunto exacto del plan guardado (jsonb @>)",
    Object.entries(filtro).every(([k, v]) => plan[k] === v) && typeof filtroFacturaQueEspera(uuid) === "string");
}

// ── 4. Qué adjunto es el documento ───────────────────────────────────────────
console.log("\n4. Qué adjunto es el documento");
{
  const FACT_XML = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID>F882-0124552</cbc:ID></Invoice>`;
  const CDR_XML = `<?xml version="1.0"?><ar:ApplicationResponse xmlns:ar="urn:oasis">…</ar:ApplicationResponse>`;
  const trio = [
    { nombre: "R-20127765279-01-F882-0124552.xml", texto: CDR_XML },
    { nombre: "20127765279-01-F882-0124552.xml", texto: FACT_XML },
    { nombre: "20127765279-01-F882-0124552.pdf", inicio: "%PDF-" },
  ];
  chk("el correo de COESTI (CDR, XML y PDF): el PDF del comprobante", JSON.stringify(elegirDocumentoFactura(trio)) === JSON.stringify({ indice: 2, tipo: "pdf" }));
  chk("sin PDF: el XML de la factura, NUNCA la CDR (aunque venga primero)",
    JSON.stringify(elegirDocumentoFactura(trio.slice(0, 2))) === JSON.stringify({ indice: 1, tipo: "xml" }));
  chk("solo la CDR: nada que enseñar", elegirDocumentoFactura([trio[0]]) === null);
  chk("un PDF sin nombre de comprobante + el XML: el XML (es la factura con seguridad)",
    elegirDocumentoFactura([{ nombre: "documento.pdf", inicio: "%PDF-" }, trio[1]])?.tipo === "xml");
  chk("solo un PDF suelto: ese, con su nombre a la vista", JSON.stringify(elegirDocumentoFactura([{ nombre: "Factura.PDF", inicio: "%PDF-" }])) === JSON.stringify({ indice: 0, tipo: "pdf" }));
  chk("un «.pdf» que no empieza por %PDF- no se enseña como PDF",
    elegirDocumentoFactura([{ nombre: "20127765279-01-F882-0124552.pdf", inicio: "<html" }]) === null &&
    elegirDocumentoFactura([{ nombre: "20127765279-01-F882-0124552.pdf", inicio: "<html" }, trio[1]])?.tipo === "xml");
  chk("sin los primeros bytes se juzga por el nombre", elegirDocumentoFactura([{ nombre: "20127765279-01-F882-0124552.pdf" }])?.tipo === "pdf");
  chk("un XML sin su texto no se puede reconocer: no se elige", elegirDocumentoFactura([{ nombre: "20127765279-01-F882-0124552.xml" }]) === null);
  chk("sin adjuntos: null", elegirDocumentoFactura([]) === null);
}

// ── 5. El correo en Gmail ────────────────────────────────────────────────────
console.log("\n5. El correo en Gmail");
{
  chk("se abre en la cuenta del buzón", enlaceGmail("199a1b2c3d4e5f60", "Transporte@AfaToursPeru.com") === "https://mail.google.com/mail/u/transporte@afatoursperu.com/#all/199a1b2c3d4e5f60");
  chk("sin saber el buzón: la primera cuenta (u/0), que es lo único que se puede decir", enlaceGmail("199a1b2c3d4e5f60", null) === "https://mail.google.com/mail/u/0/#all/199a1b2c3d4e5f60");
  chk("una dirección que corta la ruta no se mete en ella", enlaceGmail("199a1b2c3d4e5f60", "x@y.com/../#evil")?.includes("/u/0/") === true);
  chk("un id que no es de Gmail no da enlace", enlaceGmail("../x", "a@b.com") === null && enlaceGmail("", null) === null && enlaceGmail(null) === null && enlaceGmail("zzzz-1") === null);
}

// ── 6. El tipo con que se enseña ─────────────────────────────────────────────
console.log("\n6. El tipo con que se enseña");
{
  chk("un PDF como PDF (lo abre el visor del navegador)", tipoParaMostrar("pdf") === "application/pdf");
  chk("un XML como TEXTO, jamás como documento", /^text\/plain/.test(tipoParaMostrar("xml")) && !/xml|html/.test(tipoParaMostrar("xml")));
  chk("de dónde salieron los números, en palabras", fuenteDeLectura("xml_ubl") === "leída del XML de SUNAT" && fuenteDeLectura("vision_pdf") === "leída del PDF con IA" && fuenteDeLectura(null) === null);
}

// ── 7. La instrucción vieja «descarta esta fila» ─────────────────────────────
console.log("\n7. La recarga procesada antes de la fusión dice «descarta esta fila»");
{
  // El texto REAL de la pantalla (CWQ400, 18/09), guardado al procesarla.
  const REAL = "Esta carga ya entró DESDE LA FACTURA del correo (registro #63, S/ 56.68, fechado el 2026-09-19): la factura sale con su " +
    "fecha de emisión, que puede ser un día después del voucher. Es el mismo despacho — descarta esta fila; si de verdad fue otra carga, regístrala a mano.";
  const hoy = buscarCargaRegistrada({ fecha: "2026-09-18", comprobante: null, monto: 56.68 },
    [{ id: 63, fecha: "2026-09-19", total: 56.68, observaciones: OBS_63, misma_unidad: true }]);
  chk("el texto real contiene la frase vieja, entera", REAL.includes(INSTRUCCION_VIEJA_DESCARTAR));
  chk("al día: dice FUSIÓNALA, ya no «descarta»", !/descarta esta fila/.test(detalleVigente("posible_duplicado", REAL)) && /FUSIÓNALA/.test(detalleVigente("posible_duplicado", REAL)));
  chk("…y queda EXACTAMENTE como lo escribe hoy el Radar para la misma carga (el ciclo)", detalleVigente("posible_duplicado", REAL) === hoy?.detalle, hoy?.detalle);
  chk("el texto de hoy no cambia (idempotente)", detalleVigente("posible_duplicado", hoy!.detalle) === hoy!.detalle && hoy!.detalle.includes(INSTRUCCION_FUSIONAR_FACTURA));
  chk("otra anomalía no se toca, diga lo que diga", detalleVigente("monto_inconsistente", REAL) === REAL);
  chk("sin detalle: texto vacío, sin romper", detalleVigente("posible_duplicado", null) === "");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
