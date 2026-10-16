// Pruebas del REINTENTO CON COPIAS GIRADAS del voucher (lib/radar/voucher-girado.ts, PURO, y
// lib/radar/imagenes-giradas.ts). No tocan la base ni llaman a la IA.
// Uso:  npx tsx scripts/prueba-voucher-girado.mts   (sale con código 1 si algo falla)
//
// EL CASO REAL (Radar IA → Combustible, 14/10/2026): CTV-370, dos fotos —el tablero y la nota de COESTI
// fotografiada DE LADO—. La nota era nítida, pero la lectura volvió con vio_nota: true y la cantidad y
// el importe en null, y la fila quedó «Voucher ilegible». Fija:
//
//   1. cuándo se reintenta: el caso real sí; una lectura con dos de los tres números no (el cuadre
//      deriva el tercero); sin foto del papel no;
//   2. TODO lo que dispara el reintento, acciones.ts lo marca `voucher_no_leido` (barrido): si no, se
//      gastaría una lectura en una fila que ya no estaba «ilegible»;
//   3. cuántas copias, con el tope;
//   4. cuándo la segunda lectura reemplaza a la primera (nunca empeora la fila);
//   5. lo que se le dice al modelo: una copia NO es otra nota;
//   6. las copias giran de verdad (sharp, sobre una imagen sintética en un data: URL).
import {
  voucherSinLeer, numerosDelVoucher, girosPara, aceptarLecturaGirada, notaReintentoGirado, rotuloCopia,
  MAX_COPIAS_GIRADAS, DETALLE_LECTURA_GIRADA,
} from "../lib/radar/voucher-girado.ts";
import { copiasGiradas } from "../lib/radar/imagenes-giradas.ts";

let fallos = 0;
let ok = 0;
function check(nombre: string, cond: boolean, extra?: unknown) {
  if (cond) ok++;
  else {
    fallos++;
    console.log(`✗ ${nombre}`, extra ?? "");
  }
}

// ── 1. Cuándo se reintenta ──────────────────────────────────────────────────
const casoReal = {
  placa: "CTV-370", vio_nota: true, vio_surtidor: false, vio_tablero: true,
  galones: null, litros: null, precio_galon: null, precio_litro: null, monto_total: null,
  kilometraje: 31814, trip_km: 657.7,
};
check("1a caso real CTV-370: se reintenta", voucherSinLeer(casoReal) === true);
check("1b con cantidad e importe no se reintenta", voucherSinLeer({ ...casoReal, galones: 11.463, monto_total: 285.31 }) === false);
check("1c con cantidad y precio no se reintenta (se deriva el importe)", voucherSinLeer({ ...casoReal, galones: 11.463, precio_galon: 24.89 }) === false);
check("1d con precio e importe no se reintenta (se deriva la cantidad)", voucherSinLeer({ ...casoReal, precio_galon: 24.89, monto_total: 285.31 }) === false);
check("1e solo el importe: se reintenta", voucherSinLeer({ ...casoReal, monto_total: 285.31 }) === true);
check("1f sin foto del papel no se reintenta (es dato ausente, no ilegible)", voucherSinLeer({ ...casoReal, vio_nota: false }) === false);
check("1g con el surtidor también", voucherSinLeer({ ...casoReal, vio_nota: false, vio_surtidor: true }) === true);
check("1h vio_nota como texto no cuenta", voucherSinLeer({ ...casoReal, vio_nota: "true" }) === false);
check("1i null/undefined", voucherSinLeer(null) === false && voucherSinLeer(undefined) === false);
check("1j un cero no es un número leído", numerosDelVoucher({ galones: 0, monto_total: 0, precio_galon: 0 }) === 0);
check("1k litros cuentan como cantidad", numerosDelVoucher({ litros: 40, monto_total: 200 }) === 2);

// ── 2. Barrido: reintento ⇒ acciones.ts levanta voucher_no_leido ─────────────
// La condición de acciones.ts, sobre los números DESPUÉS del cuadre: con dos de tres, el cuadre deriva
// el tercero. Se modela esa derivación para comparar.
function accionesMarcaIlegible(d: any): boolean {
  const n = (v: unknown) => (v == null || v === "" || !(Number(v) > 0) ? null : Number(v));
  let cantidad = n(d.galones) ?? n(d.litros);
  let precio = n(d.precio_galon) ?? n(d.precio_litro);
  let monto = n(d.monto_total);
  const presentes = [cantidad, precio, monto].filter((x) => x != null).length;
  if (presentes === 2) {
    if (cantidad == null) cantidad = monto! / precio!;
    else if (precio == null) precio = monto! / cantidad;
    else monto = cantidad * precio!;
  }
  return (cantidad == null || (monto == null && precio == null)) && (d.vio_nota === true || d.vio_surtidor === true);
}
const valores = [null, 0, 11.463];
let combos = 0;
let reintentos = 0;
for (const galones of valores) for (const litros of valores) for (const precio_galon of [null, 24.89])
  for (const monto_total of [null, 0, 285.31]) for (const vio_nota of [true, false]) for (const vio_surtidor of [true, false]) {
    const d = { galones, litros, precio_galon, monto_total, vio_nota, vio_surtidor };
    combos++;
    if (voucherSinLeer(d)) {
      reintentos++;
      check(`2 reintento ⇒ ilegible ${JSON.stringify(d)}`, accionesMarcaIlegible(d));
    }
    // y lo que acciones marca ilegible, con el papel visto, siempre se reintenta
    if (accionesMarcaIlegible(d)) check(`2 ilegible ⇒ reintento ${JSON.stringify(d)}`, voucherSinLeer(d));
  }
check("2 corolario: el barrido sí produce reintentos", reintentos > 0 && reintentos < combos, { reintentos, combos });

// ── 3. Cuántas copias ───────────────────────────────────────────────────────
check("3a sin imágenes, ninguna", girosPara(0).length === 0 && girosPara(-1).length === 0 && girosPara(NaN).length === 0);
check("3b con 2 fotos (el caso real), los tres giros", JSON.stringify(girosPara(2)) === "[90,270,180]");
check("3c con 4 fotos, los tres", girosPara(4).length === 3);
check("3d con 5 fotos, solo los de costado", JSON.stringify(girosPara(5)) === "[90,270]");
for (let n = 1; n <= 12; n++) {
  check(`3e tope de copias con ${n} fotos`, n * girosPara(n).length <= MAX_COPIAS_GIRADAS);
}
check("3f con las 8 fotos del cluster todavía se reintenta", girosPara(8).length === 2);

// ── 4. Cuándo la segunda lectura reemplaza a la primera ─────────────────────
check("4a leyó cantidad e importe: se usa",
  aceptarLecturaGirada("combustible", { ...casoReal, galones: 11.463, precio_galon: 24.89, monto_total: 285.31 }).usar === true);
check("4b sigue sin leer: queda la primera",
  aceptarLecturaGirada("combustible", casoReal).motivo === "sigue_sin_leer");
check("4c solo un número: queda la primera",
  aceptarLecturaGirada("combustible", { ...casoReal, monto_total: 285.31 }).usar === false);
check("4d cambió de categoría: queda la primera",
  aceptarLecturaGirada("odometro", { galones: 11.463, monto_total: 285.31 }).motivo === "otra_categoria");
check("4e sin respuesta", aceptarLecturaGirada("combustible", null).motivo === "sin_respuesta");
check("4f aunque no marque vio_nota, con los números sirve",
  aceptarLecturaGirada("combustible", { galones: 11.463, monto_total: 285.31 }).usar === true);

// ── 5. Lo que se le dice al modelo ──────────────────────────────────────────
const nota = notaReintentoGirado(2);
check("5a dice que una copia es la MISMA foto", /MISMA foto/.test(nota));
check("5b no cuenta las copias como otro despacho", /recargas_adicionales/.test(nota) && /comprobantes_vistos/.test(nota));
check("5c el tablero desde la original", /TABLERO/.test(nota) && /ORIGINAL/.test(nota));
check("5d no deducir", /null/.test(nota));
check("5e rótulo nombra la foto y el giro", rotuloCopia(2, 90).includes("foto 2") && rotuloCopia(2, 90).includes("90°") && rotuloCopia(1, 180).includes("cabeza"));
check("5f la observación de la fila no promete nada falso", /copia derecha/.test(DETALLE_LECTURA_GIRADA));

// ── 6. Las copias giran de verdad ───────────────────────────────────────────
const sharpMod: any = await import("sharp");
const sharp = sharpMod.default ?? sharpMod;
const ancho = 40, alto = 10;
const png: Buffer = await sharp({ create: { width: ancho, height: alto, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const copias = await copiasGiradas([dataUrl, "data:image/png;base64,bm8gZXMgdW5hIGltYWdlbg=="], [90, 270, 180]);
check("6a sharp disponible", copias !== null);
if (copias) {
  check("6b una copia por giro de la foto buena, ninguna de la rota", copias.length === 3 && copias.every((c) => c.indice === 0), copias.map((c) => [c.indice, c.giro]));
  for (const c of copias) {
    const meta = await sharp(Buffer.from(c.base64, "base64")).metadata();
    const esperado = c.giro === 180 ? [ancho, alto] : [alto, ancho];
    check(`6c giro ${c.giro}° cambia las dimensiones`, meta.width === esperado[0] && meta.height === esperado[1], [meta.width, meta.height]);
    check(`6d giro ${c.giro}° sale en JPEG`, meta.format === "jpeg" && c.mime === "image/jpeg");
  }
}
const grande: Buffer = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
const reducidas = await copiasGiradas([`data:image/jpeg;base64,${grande.toString("base64")}`], [90]);
if (reducidas && reducidas[0]) {
  const meta = await sharp(Buffer.from(reducidas[0].base64, "base64")).metadata();
  check("6e una foto grande se reduce al lado de 1568 px", Math.max(meta.width ?? 0, meta.height ?? 0) === 1568 && meta.height! > meta.width!, [meta.width, meta.height]);
} else check("6e una foto grande se reduce", false);
check("6f sin URLs, sin copias", (await copiasGiradas([], [90]))?.length === 0);

console.log(`\n${ok} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
