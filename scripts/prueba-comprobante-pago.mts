// npx tsx scripts/prueba-comprobante-pago.mts
// El comprobante del cliente (lib/traslados/comprobante-pago.ts). Fija:
//  · el prompt del lector no lleva NINGUNA cifra (ni de ejemplo);
//  · la respuesta del modelo se lee aunque venga con ```json, con texto alrededor, con una coma de
//    más, con el monto en texto o la fecha en DD/MM/AAAA; una respuesta rota es null, nunca lanza;
//  · `seguro` ⇒ el monto está entre el adelanto y el total, en la moneda, con fecha en el rango y una
//    operación no repetida; una fecha futura, una operación repetida, otra moneda o una lectura
//    ilegible nunca dan `coincide`; corolario: el barrido sí produce lecturas seguras;
//  · el destino es tri-estado; todo código cumple el CHECK de la base [a-z_]{2,40};
//  · `comprobanteCuenta`: lo que el lector leyó y no es comprobante no cuenta; sin lectura, cuenta;
//  · el adjunto del correo se reconoce por sus primeros bytes (JPEG, PNG, WEBP, PDF) y nada más.
import {
  PROMPT_COMPROBANTE, TEXTO_COTEJO, comprobanteCuenta, cotejarComprobante, destinoCoincide, fechaDeLectura, formatoPorFirma,
  leerRespuestaComprobante, monedaDeTexto, normalizarOperacion, numeroDeTextoMonto, textoMontoCoherente,
  type CodigoCotejo, type LecturaComprobante,
} from "../lib/traslados/comprobante-pago";
import type { CuentaBancaria } from "../lib/empresa-perfil";
import { MAX_ADJUNTO_BYTES, adjuntoDeComprobante } from "../lib/traslados/reserva-correo";
import { BUCKETS_LECTOR, MAX_PDF_LECTOR_BYTES } from "../lib/traslados/comprobante-pago-ia";

let ok = 0, mal = 0;
const fallas: string[] = [];
const t = (n: string, c: boolean) => { if (c) ok++; else { mal++; if (fallas.length < 40) fallas.push(n); } };

// ── 1. El prompt ─────────────────────────────────────────────────────────────
t("el prompt no lleva ninguna cifra", !/\d/.test(PROMPT_COMPROBANTE));
t("el prompt pide JSON y transcribir", PROMPT_COMPROBANTE.includes("JSON") && PROMPT_COMPROBANTE.includes("texto_monto") && PROMPT_COMPROBANTE.includes("numero_operacion"));
t("el prompt avisa de instrucciones dentro de la imagen", /instrucciones/.test(PROMPT_COMPROBANTE));

// ── 2. Leer la respuesta ─────────────────────────────────────────────────────
{
  const base = { es_comprobante: true, texto_monto: "S/ 88.50", monto: 88.5, moneda: "PEN", fecha: "2026-10-21", hora: "21:14", numero_operacion: "00123456", medio: "Yape", banco_origen: "BCP", banco_destino: null, cuenta_destino: "*** *** 321", titular_destino: "Transportes E.", confianza: "alta" };
  const l1 = leerRespuestaComprobante(JSON.stringify(base));
  t("JSON limpio", !!l1 && l1.monto === 88.5 && l1.moneda === "PEN" && l1.fecha === "2026-10-21" && l1.hora === "21:14" && l1.medio === "yape" && l1.confianza === "alta");
  const l2 = leerRespuestaComprobante("Claro, aquí está:\n```json\n" + JSON.stringify(base) + "\n```\nSaludos");
  t("con ```json y texto alrededor", !!l2 && l2.monto === 88.5);
  const l3 = leerRespuestaComprobante('{"es_comprobante": "sí", "texto_monto": "S/ 1,234.50", "monto": "S/ 1,234.50", "fecha": "21/10/2026", "numero_operacion": "N° 00-123.456",}');
  t("monto en texto, fecha DD/MM/AAAA, coma de más", !!l3 && l3.es_comprobante && l3.monto === 1234.5 && l3.fecha === "2026-10-21" && l3.moneda === "PEN");
  t("moneda deducida del símbolo", leerRespuestaComprobante('{"texto_monto": "US$ 25.00", "monto": 25}')?.moneda === "USD");
  t("sin es_comprobante con monto → se toma como comprobante", leerRespuestaComprobante('{"monto": 25}')?.es_comprobante === true);
  t("es_comprobante false se respeta", leerRespuestaComprobante('{"es_comprobante": false, "monto": 25}')?.es_comprobante === false);
  for (const roto of ["", "nada", "[1,2]", "{no es json", '{"monto": }', null, 42, ["x"]]) t(`respuesta rota → null (${String(roto).slice(0, 12)})`, leerRespuestaComprobante(roto) === null);
  const l4 = leerRespuestaComprobante({ monto: -5, fecha: "2026-02-30", hora: "25:00", texto_monto: "x".repeat(200), numero_operacion: "null" });
  t("valores imposibles se descartan", !!l4 && l4.monto === null && l4.fecha === null && l4.hora === null && Array.from(l4.texto_monto ?? "").length <= 40 && l4.numero_operacion === null);
  t("fechaDeLectura", fechaDeLectura("2026-1-5") === "2026-01-05" && fechaDeLectura("5/1/2026") === "2026-01-05" && fechaDeLectura("31/04/2026") === null);
  t("monedaDeTexto", monedaDeTexto("S/ 10") === "PEN" && monedaDeTexto("10 soles") === "PEN" && monedaDeTexto("$ 10") === "USD" && monedaDeTexto("10") === null);
  t("numeroDeTextoMonto", numeroDeTextoMonto("S/ 1,234.50") === 1234.5 && numeroDeTextoMonto("S/88") === 88 && numeroDeTextoMonto("S/ 1 234.50") === 1234.5 && numeroDeTextoMonto("sin número") === null);
}

// ── 3. La operación ──────────────────────────────────────────────────────────
t("normalizarOperacion quita rótulo, símbolos y ceros", normalizarOperacion("N° 00-123.456") === "123456" && normalizarOperacion("Nro. de operación: 0012345") === "12345" && normalizarOperacion("Operación 0099") === "99");
t("normalizarOperacion conserva letras del código", normalizarOperacion("NX123") === "NX123" && normalizarOperacion("op-ab12") === "AB12");
t("normalizarOperacion vacía → null", normalizarOperacion("  - . ") === null && normalizarOperacion(null) === null);
t("texto_monto coherente", textoMontoCoherente({ monto: 88.5, texto_monto: "S/ 88.50" }) && !textoMontoCoherente({ monto: 88.5, texto_monto: "S/ 85.50" }) && !textoMontoCoherente({ monto: 88.5, texto_monto: null }));

// ── 4. El destino (tri-estado) ───────────────────────────────────────────────
{
  const cuentas: CuentaBancaria[] = [{ banco: "BCP", cuenta: "191-1111111-0-11", cci: "002-191-001111111011-11" }];
  t("cuenta completa que coincide", destinoCoincide({ cuenta_destino: "191-1111111-0-11", medio: "transferencia" }, cuentas) === true);
  t("enmascarada por sus últimos dígitos", destinoCoincide({ cuenta_destino: "****0-11", medio: "transferencia" }, cuentas) === true);
  t("otra cuenta → false", destinoCoincide({ cuenta_destino: "193-9999999-0-99", medio: "transferencia" }, cuentas) === false);
  t("sin cuenta visible → null", destinoCoincide({ cuenta_destino: null, medio: "transferencia" }, cuentas) === null && destinoCoincide({ cuenta_destino: "**", medio: null }, cuentas) === null);
  t("Yape sin cuenta Yape → null (un celular no se compara contra un banco)", destinoCoincide({ cuenta_destino: "*** *** 321", medio: "yape" }, cuentas) === null);
  t("sin cuentas → null", destinoCoincide({ cuenta_destino: "191-1111111-0-11", medio: null }, []) === null);
}

// ── 5. El cotejo: barrido ────────────────────────────────────────────────────
const CODIGOS: CodigoCotejo[] = ["coincide", "pago_total", "monto_menor", "monto_mayor_total", "otra_moneda", "sin_moneda", "fecha_futura", "fecha_anterior", "sin_fecha", "sin_operacion", "operacion_repetida", "destino_no_coincide", "ilegible", "no_es_comprobante"];
t("todo código tiene su texto", CODIGOS.every((c) => typeof TEXTO_COTEJO[c] === "string" && TEXTO_COTEJO[c].length > 10) && Object.keys(TEXTO_COTEJO).length === CODIGOS.length);
t("todo código cumple el CHECK de la base [a-z_]{2,40}", CODIGOS.every((c) => /^[a-z_]{2,40}$/.test(c)));
{
  const cuentas: CuentaBancaria[] = [{ banco: "BCP", cuenta: "191-1111111-0-11", cci: "002-191-001111111011-11" }];
  const hoy = "2026-10-22", desde = "2026-10-20";
  let casos = 0, invOk = 0, seguros = 0, futurosOk = 0, futuros = 0, repetidosOk = 0, repetidos = 0, duroOk = 0, duros = 0, formatoOk = true;
  const vistos = new Set<string>();
  for (const adelanto of [null, 88.5]) for (const monto of [null, 50, 88.5, 120, 177, 200]) for (const coherente of [true, false]) for (const moneda of ["PEN", "USD", null] as const)
    for (const fecha of [null, "2026-10-19", "2026-10-21", "2026-10-23"]) for (const op of [null, "123456", "999"]) for (const dest of [null, "191-1111111-0-11", "193-9"]) for (const es of [true, false]) {
      const l: LecturaComprobante = {
        es_comprobante: es, monto, texto_monto: monto == null ? null : coherente ? `S/ ${monto.toFixed(2)}` : `S/ ${(monto + 1).toFixed(2)}`,
        moneda, fecha, hora: "10:00", numero_operacion: op, medio: "transferencia", banco_origen: null, banco_destino: null, cuenta_destino: dest, titular_destino: null, confianza: "alta",
      };
      const c = cotejarComprobante(l, { adelanto, total: 177, moneda: "PEN", hoy, desde, operacionesPrevias: ["N° 999"], cuentas });
      casos++;
      for (const k of c.codigos) vistos.add(k);
      if (!c.codigos.every((k) => /^[a-z_]{2,40}$/.test(k))) formatoOk = false;
      const esperado = adelanto ?? 177;
      const segInv = !c.seguro || (c.monto != null && c.monto >= esperado - 0.005 && c.monto <= 177 + 0.005 && moneda === "PEN" && fecha != null && fecha >= desde && fecha <= hoy && op === "123456" && dest !== "193-9" && es && coherente);
      if (segInv) invOk++; else if (fallas.length < 40) fallas.push(`seguro sin respaldo ${JSON.stringify(l)} → ${JSON.stringify(c)}`);
      if (c.seguro) seguros++;
      if (fecha === "2026-10-23") { futuros++; if (!c.seguro && !c.codigos.includes("coincide") && !c.codigos.includes("pago_total")) futurosOk++; }
      if (op === "999") { repetidos++; if (!c.seguro && (!es || c.codigos.includes("operacion_repetida")) && !c.codigos.includes("coincide")) repetidosOk++; }
      if (!coherente || moneda === "USD") { duros++; if (!c.seguro && !c.codigos.includes("coincide") && !c.codigos.includes("pago_total")) duroOk++; }
      if (!es && !(c.codigos.length === 1 && c.codigos[0] === "no_es_comprobante")) fallas.push("no_es_comprobante debe ir solo");
    }
  t(`seguro ⇒ monto entre el adelanto y el total, todo en regla (${invOk}/${casos})`, invOk === casos);
  t(`fecha futura nunca coincide (${futurosOk}/${futuros})`, futuros > 0 && futurosOk === futuros);
  t(`operación repetida nunca coincide (${repetidosOk}/${repetidos})`, repetidos > 0 && repetidosOk === repetidos);
  t(`ilegible u otra moneda nunca coincide (${duroOk}/${duros})`, duros > 0 && duroOk === duros);
  t("formato de los códigos devueltos", formatoOk);
  t(`corolario: el barrido produce lecturas seguras (${seguros})`, seguros > 0);
  t("corolario: salen todos los códigos", CODIGOS.every((k) => vistos.has(k)));
}

// ── 6. Casos con nombre ──────────────────────────────────────────────────────
{
  const l: LecturaComprobante = { es_comprobante: true, monto: 88.5, texto_monto: "S/ 88.50", moneda: "PEN", fecha: "2026-10-21", hora: "21:14", numero_operacion: "Op. 00123456", medio: "yape", banco_origen: "BCP", banco_destino: null, cuenta_destino: "*** *** 321", titular_destino: null, confianza: "alta" };
  const x = { adelanto: 88.5, total: 177, moneda: "PEN" as const, hoy: "2026-10-22", desde: "2026-10-20", operacionesPrevias: [], cuentas: [] };
  const c = cotejarComprobante(l, x);
  t("Yape del adelanto exacto → coincide y seguro", c.seguro && c.codigos.join() === "coincide" && c.operacion === "123456" && c.monto === 88.5);
  t("el total entero → pago_total", cotejarComprobante({ ...l, monto: 177, texto_monto: "S/ 177.00" }, x).codigos.join() === "pago_total");
  t("entre el adelanto y el total → coincide (cubre el adelanto)", cotejarComprobante({ ...l, monto: 100, texto_monto: "S/ 100.00" }, x).codigos.join() === "coincide");
  t("menos que el adelanto → monto_menor, no seguro", (() => { const r = cotejarComprobante({ ...l, monto: 50, texto_monto: "S/ 50.00" }, x); return r.codigos[0] === "monto_menor" && !r.seguro; })());
  t("más que el total → monto_mayor_total", cotejarComprobante({ ...l, monto: 300, texto_monto: "S/ 300.00" }, x).codigos[0] === "monto_mayor_total");
  t("crédito (sin adelanto): el total coincide", cotejarComprobante({ ...l, monto: 177, texto_monto: "S/ 177.00" }, { ...x, adelanto: null }).codigos.join() === "coincide");
  t("null → no_es_comprobante", cotejarComprobante(null, x).codigos.join() === "no_es_comprobante");
  t("operación repetida aunque cambie el formato", cotejarComprobante(l, { ...x, operacionesPrevias: ["123456"] }).codigos.includes("operacion_repetida"));
}

// ── 6. ¿Cuenta como un pago reportado? (UNA definición: cancelación, cierre, vencimiento) ─────
{
  const leida = (r: unknown) => leerRespuestaComprobante(JSON.stringify(r));
  t("una imagen que el lector LEYÓ y dijo que no es comprobante NO cuenta", comprobanteCuenta(leida({ es_comprobante: false, monto: null })) === false && comprobanteCuenta({ es_comprobante: false }) === false);
  t("un comprobante leído cuenta", comprobanteCuenta(leida({ es_comprobante: true, monto: 50, texto_monto: "S/ 50.00" })) === true);
  t("sin lectura (el lector falló, fila vieja) cuenta: lo mira una persona", comprobanteCuenta(null) && comprobanteCuenta(undefined) && comprobanteCuenta("x") && comprobanteCuenta([]));
  t("una lectura rara sin la clave cuenta (el lado seguro: frena)", comprobanteCuenta({ monto: 10 }) && comprobanteCuenta({ es_comprobante: "no" }));
  // Coherente con cómo se decide al registrarlo: lo que el cotejo llama `no_es_comprobante` con lectura
  // es exactamente lo que no cuenta; sin lectura el cotejo también dice `no_es_comprobante` y SÍ cuenta.
  const xc = { adelanto: 50, total: 100, moneda: "PEN" as const, hoy: "2026-10-21", desde: "2026-10-20", operacionesPrevias: [], cuentas: [] };
  let coherente = true;
  for (const es of [true, false, undefined]) for (const monto of [null, 50]) {
    const l = leida({ es_comprobante: es, monto, texto_monto: monto ? "S/ 50.00" : null });
    const noEs = cotejarComprobante(l, xc).codigos.includes("no_es_comprobante");
    if (l && noEs === comprobanteCuenta(l)) coherente = false;
  }
  t("con lectura: «no es comprobante» en el cotejo ⟺ no cuenta", coherente);
}

// ── 7. El adjunto del correo, por su contenido ───────────────────────────────
{
  const b = (...xs: number[]) => new Uint8Array([...xs, ...new Array(16).fill(0)]);
  t("JPEG, PNG, WEBP y PDF se reconocen por sus primeros bytes",
    formatoPorFirma(b(0xff, 0xd8, 0xff, 0xe0))?.ext === "jpg" && formatoPorFirma(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.ext === "png"
    && formatoPorFirma(b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))?.ext === "webp" && formatoPorFirma(b(0x25, 0x50, 0x44, 0x46, 0x2d))?.mime === "application/pdf");
  const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
  t("un HTML, un ZIP, un RIFF que no es WEBP, un archivo corto o vacío → no se reconoce",
    formatoPorFirma(html) === null && formatoPorFirma(b(0x50, 0x4b, 0x03, 0x04)) === null && formatoPorFirma(b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20)) === null
    && formatoPorFirma(new Uint8Array([0xff, 0xd8, 0xff])) === null && formatoPorFirma(null) === null && formatoPorFirma(new Uint8Array()) === null);
  const okJ = adjuntoDeComprobante(b(0xff, 0xd8, 0xff, 0xe0), "comprobante-cotizacion-00736");
  t("adjunto: con su extensión por el contenido (no por el nombre)", okJ.ok && okJ.nombre === "comprobante-cotizacion-00736.jpg" && okJ.mime === "image/jpeg");
  const pdf = adjuntoDeComprobante(b(0x25, 0x50, 0x44, 0x46, 0x2d), "comp/../x?y");
  t("adjunto: el nombre se limpia", pdf.ok && /^[A-Za-z0-9._-]+\.pdf$/.test(pdf.nombre));
  const noHtml = adjuntoDeComprobante(html, "c"), noBaja = adjuntoDeComprobante(null, "c"), grande = adjuntoDeComprobante(new Uint8Array(MAX_ADJUNTO_BYTES + 1).fill(0xff), "c");
  t("adjunto: lo que no es imagen ni PDF, lo que no se bajó y lo enorme NO van, y dicen por qué",
    !noHtml.ok && /no es una imagen/.test(noHtml.motivo) && !noBaja.ok && /no se pudo bajar/.test(noBaja.motivo) && !grande.ok && /pesa más/.test(grande.motivo));
  t("el lector solo lee de crm-media y un PDF de hasta 2 MB", BUCKETS_LECTOR.join() === "crm-media" && MAX_PDF_LECTOR_BYTES === 2 * 1024 * 1024);
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0 || fallas.length > 0) process.exit(1);
console.log("Todo OK");
