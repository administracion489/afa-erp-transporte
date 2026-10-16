// UNA NOTA DE LADO NO ES UNA NOTA ILEGIBLE · el reintento con copias giradas (módulo PURO).
//
// El caso (CTV-370, 14/10/2026): el conductor mandó el tablero y la nota de despacho de COESTI, y la
// nota estaba fotografiada DE LADO (el texto corre de abajo hacia arriba). La foto era nítida —girándola
// se lee todo— pero el modelo devolvió `vio_nota: true` con la cantidad y el importe en null, y la fila
// quedó «Voucher ilegible» con el grifo, el tipo, la cantidad y el precio vacíos. Los modelos de visión
// leen mucho peor un texto girado 90° que uno derecho, y ninguna instrucción del prompt cambia eso del
// todo: lo que sí funciona es darles la foto ya derecha.
//
// Por eso, cuando la primera lectura vio el papel y NO sacó los números, el motor vuelve a preguntar UNA
// vez con las fotos originales MÁS copias giradas 90°, 270° y 180° (lib/radar/imagenes-giradas.ts las
// genera). No se sabe cuál de las fotos es la nota —puede ser cualquiera del álbum— ni hacia qué lado
// está girada, así que se giran todas.
//
// Este módulo decide, sin tocar la base ni la red:
//   - si hace falta el reintento (`voucherSinLeer`: vio el papel y le faltan DOS de los tres números
//     —cantidad, precio, importe—. Con dos, el cuadre de lib/radar/coherencia-voucher.ts deriva el
//     tercero y la fila no queda «ilegible», así que gastar otra lectura ahí no arregla nada. Todo lo
//     que esto marca, acciones.ts lo marca `voucher_no_leido`: la matriz lo fija);
//   - cuántas copias (`girosPara`: el costo crece con cada imagen y esto solo corre cuando ya falló);
//   - qué se le dice al modelo (`notaReintentoGirado`: una copia girada NO es otra nota, o el detector de
//     álbumes con dos despachos —album-recargas.ts— vería dos vouchers donde hay uno);
//   - y si la segunda lectura sirve (`aceptarLecturaGirada`): solo si leyó lo que faltaba y sigue siendo
//     combustible. Si no mejoró, se queda la primera: un reintento nunca empeora la fila.
//
// Matriz: npx tsx scripts/prueba-voucher-girado.mts

/** Ángulos (sentido horario) de las copias. 90 y 270 primero: una nota de lado es lo más común. */
export type Giro = 90 | 180 | 270;

/** Tope de copias por reintento. Operativo, no medido: con 8 fotos son 16 copias (~25 k tokens). */
export const MAX_COPIAS_GIRADAS = 16;

/** Número positivo o null — la misma lectura que `numOpc` de acciones.ts. */
function numOpc(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cuántos de los tres números del voucher (cantidad, precio unitario, importe) trae la lectura. */
export function numerosDelVoucher(d: any): number {
  if (!d || typeof d !== "object") return 0;
  const cantidad = numOpc(d.galones) ?? numOpc(d.litros);
  const precioUnit = numOpc(d.precio_galon) ?? numOpc(d.precio_litro);
  const monto = numOpc(d.monto_total);
  return [cantidad, precioUnit, monto].filter((x) => x != null).length;
}

/**
 * ¿Vio el papel (nota o surtidor) y le faltan al menos dos de los tres números? Con dos, el cuadre
 * deriva el tercero; con menos, acciones.ts levanta `voucher_no_leido` siempre.
 */
export function voucherSinLeer(d: any): boolean {
  if (!d || typeof d !== "object") return false;
  const vioPapel = d.vio_nota === true || d.vio_surtidor === true;
  return vioPapel && numerosDelVoucher(d) < 2;
}

/**
 * Qué giros probar según cuántas fotos (imágenes, no PDF) trae el reporte. Con pocas, los tres; con
 * más, solo los de costado (una nota al revés es rara y el costo se multiplica). Sin imágenes, ninguno.
 */
export function girosPara(nImagenes: number): Giro[] {
  if (!Number.isFinite(nImagenes) || nImagenes <= 0) return [];
  const tres: Giro[] = [90, 270, 180];
  if (nImagenes * tres.length <= 12) return tres;
  const dos: Giro[] = [90, 270];
  if (nImagenes * dos.length <= MAX_COPIAS_GIRADAS) return dos;
  return [];
}

/** El rótulo que va delante de cada copia en el mensaje al modelo. */
export function rotuloCopia(numeroFoto: number, giro: Giro): string {
  const sentido = giro === 180 ? "girada 180° (de cabeza)" : `girada ${giro}° en sentido horario`;
  return `COPIA de la foto ${numeroFoto}, ${sentido} — es la MISMA foto, no otra:`;
}

/**
 * Lo que se le agrega al prompt en el reintento. Tres reglas, y la tercera es la que evita el daño:
 * leer la nota desde la copia que quede derecha, el tablero desde la original, y contar cada foto UNA
 * vez (una copia no es un segundo despacho).
 */
export function notaReintentoGirado(nFotos: number): string {
  return `

REINTENTO DE LECTURA: en una primera lectura viste la nota de despacho (o el surtidor) pero no pudiste leer la cantidad o el importe. Lo más probable es que la foto esté DE LADO o de cabeza: un papel nítido fotografiado girado NO es ilegible.
Arriba van las ${nFotos} foto(s) originales y, después, COPIAS de cada una giradas 90°, 270° y/o 180°, cada copia con su rótulo.
- Lee la NOTA DE DESPACHO desde la copia en la que su texto quede DERECHO (de izquierda a derecha y de arriba abajo). Copia sus datos con el mismo cuidado de siempre: la línea "C.CCCx PP.PPP", el importe, el producto, el encabezado del grifo, el comprobante, la fecha y la hora.
- Lee el TABLERO / odómetro desde la foto ORIGINAL si ahí se ve bien.
- Cada copia es la MISMA foto que su original: NO es otra nota ni otro despacho. No la cuentes dos veces en "recargas_adicionales" ni repitas su comprobante en "comprobantes_vistos".
- Si aun girada no se puede leer un número, déjalo en null (no lo deduzcas).
- En "notas_extraccion" di desde qué copia leíste la nota.`;
}

export type VeredictoGirado =
  | { usar: true; motivo: "leyo_lo_que_faltaba" }
  | { usar: false; motivo: "sigue_sin_leer" | "otra_categoria" | "sin_respuesta" };

/**
 * ¿La lectura con copias giradas reemplaza a la primera? Solo si sigue siendo combustible y ahora SÍ
 * trae al menos dos de los tres números del voucher (el cuadre deriva el tercero). Cualquier otra cosa se descarta y queda la primera.
 */
export function aceptarLecturaGirada(
  categoria: string | null | undefined,
  datos: any
): VeredictoGirado {
  if (!datos || typeof datos !== "object") return { usar: false, motivo: "sin_respuesta" };
  if (categoria !== "combustible") return { usar: false, motivo: "otra_categoria" };
  // Que no haya marcado vio_nota/vio_surtidor en el reintento no lo vuelve «leído»: se exigen los números.
  if (numerosDelVoucher(datos) < 2) return { usar: false, motivo: "sigue_sin_leer" };
  return { usar: true, motivo: "leyo_lo_que_faltaba" };
}

/** La observación (no bloquea) que deja la fila leída así, para que el revisor sepa de dónde salió. */
export const DETALLE_LECTURA_GIRADA =
  "La nota venía girada en la foto: el ERP la volvió a leer desde una copia derecha (reintento automático). Si algo no cuadra, compáralo con la foto.";
