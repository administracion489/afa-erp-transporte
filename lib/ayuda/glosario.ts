// ──────────────────────────────────────────────────────────────────────────────
// lib/ayuda/glosario.ts — El diccionario contable y tributario del ERP.
//
// Está escrito para el DUEÑO del negocio, no para un contador: cada término se explica
// en castellano llano, con números de la operación real de AFA (servicios de S/ 960 y
// S/ 1,120, detracción del 10 %, la placa CWQ-400, proveedores como GRIJALVA TOURS o
// ALVAREZ FARFAN) y con la trampa típica en el campo `ojo`.
//
// REGLA DE UNA SOLA FUENTE: un término se define AQUÍ una vez y los módulos lo
// referencian por clave. Si cambia la norma, se corrige en este archivo y cambia en
// todas las pantallas a la vez.
//
// HONESTIDAD: las tasas y los códigos de detracción cambian por Resolución de
// Superintendencia. En el ERP la verdad es la fila de `cat_detraccion` (editable en
// Cuentas por Pagar → Detracciones → “Tasas y códigos de detracción”), nunca una
// constante en el código ni una frase de este archivo. Donde algo lo tiene que
// confirmar el contador, se dice con esas palabras.
// ──────────────────────────────────────────────────────────────────────────────

import type { Concepto } from "@/lib/ayuda/tipos";

export const GLOSARIO: Record<string, Concepto> = {
  // ── Impuestos y régimen tributario ──────────────────────────────────────────

  igv: {
    clave: "igv",
    termino: "IGV (Impuesto General a las Ventas)",
    definicion:
      "Es el impuesto que se le suma a casi todo lo que vendes y a casi todo lo que compras. Hoy la tasa es **18 %**.\nTe importa porque el IGV que le cobras a tu cliente **no es tuyo**: lo tienes en la mano un rato y luego se lo pagas a SUNAT, descontando el IGV que tú pagaste en tus compras del mismo mes.",
    ejemplo:
      "Un servicio de S/ 1,120 con IGV incluido son S/ 949.15 de servicio y S/ 170.85 de IGV. Si ese mes tus facturas de combustible y mantenimiento traían S/ 90 de IGV, a SUNAT le pagas 170.85 − 90 = S/ 80.85.",
    ojo:
      "Dos cosas. Primera: el IGV no se saca multiplicando el total por 18 %, se saca dividiendo el total entre 1.18 (por eso de S/ 1,120 salen S/ 170.85 y no S/ 201.60). Segunda: el 18 % no está escrito a fuego en el sistema; se edita en Cuentas por Pagar → Detracciones → “Tasas y códigos de detracción”, campo “IGV vigente (%)”. De ahí lo toman las liquidaciones y el registro de comprobantes de compra. Ojo con esto: el cotizador todavía calcula con 18 % fijo, así que si algún día cambia la tasa hay que avisar para que se corrija también ahí.",
    verTambien: ["credito_fiscal", "registro_ventas", "registro_compras", "factura"],
  },

  credito_fiscal: {
    clave: "credito_fiscal",
    termino: "Crédito fiscal",
    definicion:
      "Es el IGV que pagaste en tus compras y que puedes descontar del IGV que cobraste en tus ventas.\nTe importa porque es plata: cada factura de compra bien hecha te baja lo que le pagas a SUNAT ese mes. Cada boleta suelta o cada factura mal emitida, no.",
    ejemplo:
      "Cargas combustible a la CWQ-400 por S/ 590 (S/ 500 de combustible + S/ 90 de IGV). Esos S/ 90 se restan del IGV que debes por tus ventas del mes.",
    ojo:
      "Se pierde por tonterías: boleta en vez de factura, factura a nombre del conductor y no del RUC de AFA, o factura que nunca se anotó en el Registro de Compras. Y hay una trampa propia del transporte: si la compra estaba sujeta a detracción y no depositaste, el crédito fiscal recién lo puedes usar desde el mes en que hagas el depósito.",
    verTambien: ["igv", "detraccion", "registro_compras", "boleta", "factura"],
  },

  detraccion: {
    clave: "detraccion",
    termino: "Detracción (SPOT)",
    definicion:
      "Es un descuento obligatorio que tu cliente te hace al pagarte y que **no va a su bolsillo**: lo deposita en una cuenta a tu nombre en el Banco de la Nación, de la que solo puedes sacar plata para pagar impuestos.\nTe importa porque de cada factura recibes menos efectivo del que dice el papel. No es una pérdida, es caja amarrada. Y funciona en los dos sentidos: cuando TÚ le compras a un tercero, el que deposita eres tú, a la cuenta del proveedor.",
    ejemplo:
      "Le facturas S/ 1,120 a tu cliente por un servicio de transporte de personal. Como supera los S/ 700 y el código 026 detrae el 10 %, el cliente te deposita S/ 1,008 a tu cuenta y S/ 112 a tu cuenta de detracciones del Banco de la Nación. No perdiste esos S/ 112: están ahí y solo puedes usarlos para pagar impuestos.",
    ojo:
      "Tres trampas reales.\n1) No confundas los códigos: **026 = transporte de PERSONAS, 10 %, desde S/ 700** (Anexo 3, el que suele aplicar AFA) y **027 = transporte de CARGA, 4 %, desde S/ 400**, que además se calcula sobre el importe o el valor referencial del MTC, el que sea mayor. Están seguidos y es facilísimo invertirlos.\n2) Las tasas y los umbrales cambian por Resolución de Superintendencia. En el ERP se editan en Cuentas por Pagar → Detracciones → “Tasas y códigos de detracción”, y la verdad es la fila de esa tabla, no lo que diga ningún manual. Qué código le corresponde exactamente a tu servicio lo confirma tu contador.\n3) El depósito tiene plazo, y mientras no esté hecho el comprador no puede usar el crédito fiscal de esa factura.",
    verTambien: ["spot", "banco_nacion", "valor_referencial", "credito_fiscal", "retencion"],
  },

  spot: {
    clave: "spot",
    termino: "SPOT (Sistema de Pago de Obligaciones Tributarias)",
    definicion:
      "Es el nombre oficial del sistema de detracciones. Cuando SUNAT, tu banco o tu contador digan “SPOT”, están hablando exactamente de lo mismo que en el ERP se llama detracción.",
    ejemplo:
      "En la constancia que devuelve el Banco de la Nación aparece “depósito SPOT”. Ese número es el que escribes en Cuentas por Pagar → Detracciones: eliges la factura, pulsas “Marcar depositada” y llenas “N° de constancia” y “Fecha del depósito”.",
    ojo:
      "El SPOT no es un impuesto adicional ni una comisión: no te cobra nada nuevo, solo obliga a que una parte del pago viaje por una cuenta controlada. Quien te diga que “la detracción es un impuesto más” está equivocado.",
    verTambien: ["detraccion", "banco_nacion", "sunat"],
  },

  banco_nacion: {
    clave: "banco_nacion",
    termino: "Cuenta de detracciones (Banco de la Nación)",
    definicion:
      "Es una cuenta corriente a nombre de tu empresa, en el Banco de la Nación, donde caen todas las detracciones que te hacen tus clientes.\nLa plata es tuya, pero está amarrada: solo se puede usar para pagar deudas tributarias (IGV, Impuesto a la Renta, EsSalud, multas, fraccionamientos).",
    ejemplo:
      "Si en el mes te detrajeron S/ 112 + S/ 96 + S/ 340, tienes S/ 548 en el Banco de la Nación. Cuando toque pagar el IGV del mes, esos S/ 548 salen de ahí y no de tu cuenta comercial del BCP.",
    ojo:
      "Dos cosas. Si el saldo se queda parado meses porque te detraen más de lo que pagas en impuestos, se puede pedir la **liberación de fondos** para que vuelva a tu cuenta comercial: hay fechas y requisitos, y lo tramita tu contador. Y no lo mezcles con el otro sentido: cuando compras un servicio con detracción, el depósito lo haces TÚ, a la cuenta del proveedor, no a la tuya.",
    verTambien: ["detraccion", "spot", "estado_pago"],
  },

  valor_referencial: {
    clave: "valor_referencial",
    termino: "Valor referencial (transporte de carga)",
    definicion:
      "Es una tabla de precios mínimos que publica el MTC para el transporte de carga por carretera.\nSolo te importa si mueves carga: cuando aplica, la detracción del 4 % (código 027) no se calcula sobre lo que facturaste, sino sobre el importe **o el valor referencial, el que sea mayor**.",
    ejemplo:
      "Facturas S/ 2,000 por un flete de carga, pero el valor referencial de esa ruta y ese tonelaje es S/ 2,400. La detracción se calcula sobre S/ 2,400: S/ 96, no S/ 80.",
    ojo:
      "AFA transporta personas, así que su código habitual es el 026 y este cálculo no le toca. Si algún día facturas carga, el valor referencial hay que sacarlo de las tablas del MTC: el ERP no las trae y no lo calcula por ti. Confírmalo con tu contador antes de emitir.",
    verTambien: ["detraccion", "sunat"],
  },

  retencion: {
    clave: "retencion",
    termino: "Retención",
    definicion:
      "Es cuando el que paga se queda con una parte del importe y la entrega a SUNAT a cuenta de los impuestos del que cobra.\nDonde más la vas a ver es en los recibos por honorarios: si el recibo pasa del monto que fija SUNAT, retienes el 8 % de renta de cuarta categoría y se lo pagas tú a SUNAT en nombre de esa persona.",
    ejemplo:
      "Un conductor independiente te emite un recibo por honorarios de S/ 2,000. Le retienes S/ 160 (8 %) y le transfieres S/ 1,840. Esos S/ 160 no son tuyos: los declaras y los pagas a SUNAT.",
    ojo:
      "No es lo mismo que la detracción: la detracción va a una cuenta del proveedor (sigue siendo su plata) y la retención se va a SUNAT. Además, el monto a partir del cual se retiene cuarta categoría lo actualiza SUNAT cada año y hay personas con constancia de **suspensión de retenciones**, a las que no se les retiene: pídesela y guárdala. Existe aparte un régimen de retenciones del IGV del 3 %, que solo aplica si SUNAT te designó agente de retención — casi seguro no es tu caso, pero confírmalo con tu contador.",
    verTambien: ["recibo_honorarios", "detraccion", "percepcion", "saldo"],
  },

  percepcion: {
    clave: "percepcion",
    termino: "Percepción",
    definicion:
      "Es un cobro extra que un proveedor autorizado por SUNAT te hace por encima del precio, como adelanto de tu IGV futuro.\nPara un transportista la más común es la del combustible: el mayorista o grifo designado te suma un porcentaje pequeño sobre la venta. No es un gasto: es plata tuya adelantada que luego descuentas del IGV.",
    ejemplo:
      "Compras combustible por S/ 1,180 y la factura muestra además S/ 11.80 de percepción. Pagas S/ 1,191.80, pero esos S/ 11.80 se descuentan del IGV que te toca pagar ese mes.",
    ojo:
      "El error caro es cargarla como “más combustible”: si la metes al costo, pagas dos veces (una en el grifo y otra a SUNAT). Va a un casillero aparte y la aplica tu contador, así que guarda siempre el comprobante de percepción. Qué tasa corresponde y quién es agente de percepción lo fija SUNAT y conviene confirmarlo con tu contador.",
    verTambien: ["igv", "credito_fiscal", "retencion"],
  },

  ruc: {
    clave: "ruc",
    termino: "RUC",
    definicion:
      "Son los 11 dígitos que identifican a una empresa o a una persona ante SUNAT. Las empresas empiezan con 20 y las personas naturales con 10.\nTe importa por dos motivos: sin el RUC correcto en la factura no hay crédito fiscal, y el ERP identifica a los proveedores por su RUC cuando importas una planilla.",
    ejemplo:
      "Al subir la planilla de OSLO, el ERP busca al proveedor por RUC. Así GRIJALVA TOURS entra una sola vez aunque en la hoja aparezca escrito “GRIJALVA TOURS SAC” en una fila y “GRIJALVA TOUR S.A.C.” en otra.",
    ojo:
      "Un RUC que empieza en 10 es de persona natural: si esa persona te emite recibo por honorarios, no hay IGV que descontar y puede haber retención de cuarta categoría. Y un dígito mal tecleado te crea un proveedor duplicado y una factura que nunca cruza con nada.",
    verTambien: ["factura", "recibo_honorarios", "cci", "sunat"],
  },

  cci: {
    clave: "cci",
    termino: "CCI (Código de Cuenta Interbancario)",
    definicion:
      "Son 20 dígitos que sirven para transferirle a una cuenta de OTRO banco. En el ERP se guarda por proveedor y es el dato que sale en el archivo de pagos que se sube al banco.",
    ejemplo:
      "AFA paga desde el BCP a ALVAREZ FARFAN, que tiene su cuenta en Interbank. Para que el abono salga, el archivo del lote necesita el CCI de 20 dígitos, no el número de cuenta de Interbank.",
    ojo:
      "El número de cuenta y el CCI no son lo mismo, aunque los dos sean “el número de la cuenta”. Poner uno donde va el otro hace que el banco rechace esa línea del lote — y normalmente te enteras cuando el proveedor llama preguntando por su pago.",
    verTambien: ["lote_pago", "telecredito", "ruc"],
  },

  sunat: {
    clave: "sunat",
    termino: "SUNAT",
    definicion:
      "Es la administración tributaria peruana: el organismo que cobra los impuestos, fija las tasas y define qué documentos valen.\nCuando en el ERP ves una regla rara (detracción, umbrales, códigos, libros), casi siempre viene de una norma de SUNAT, no de una decisión del sistema.",
    ejemplo:
      "El catálogo de códigos de detracción que ves en Cuentas por Pagar → Detracciones es el Catálogo 54 de SUNAT, con su anexo y su base legal fila por fila.",
    ojo:
      "Sé claro sobre qué hace y qué no hace este ERP: **no declara ni envía nada a SUNAT**, y no emite comprobantes electrónicos por ti. Lo que hace es tener los datos ordenados y cuadrados para que tu contador declare y para que tú sepas en qué estás parado. La emisión electrónica sigue haciéndose con tu facturador de siempre.",
    verTambien: ["igv", "detraccion", "registro_compras", "registro_ventas"],
  },

  tipo_cambio: {
    clave: "tipo_cambio",
    termino: "Tipo de cambio",
    definicion:
      "Es a cuántos soles equivale un dólar en una fecha concreta. Se publica todos los días y tiene dos valores: compra y venta.\nTe importa cuando facturas o compras en dólares: para la contabilidad y el IGV no vale “el dólar de hoy”, vale el publicado en la fecha que corresponde a la operación.",
    ejemplo:
      "Facturas USD 1,200 el 12 de marzo. Si ese día el tipo de cambio aplicable es 3.72, la factura vale S/ 4,464 para efectos del IGV, aunque cuando te paguen en abril el dólar esté a 3.80.",
    ojo:
      "Para el IGV, las ventas y las compras no se convierten con el mismo valor: una usa el de compra y la otra el de venta, y siempre el publicado para la fecha de la operación. No lo resuelvas de memoria ni con el dólar de la calle: es de las cosas que corrige tu contador. Y la diferencia entre el tipo de cambio del día de la factura y el del día del cobro no se pierde: es ganancia o pérdida por diferencia de cambio, y se registra aparte.",
    verTambien: ["factura", "igv", "periodo_contable"],
  },

  // ── Comprobantes ────────────────────────────────────────────────────────────

  comprobante: {
    clave: "comprobante",
    termino: "Comprobante de pago",
    definicion:
      "Es cualquier documento que sustenta una operación ante SUNAT: factura, boleta, recibo por honorarios, nota de crédito, ticket.\nEn este ERP el comprobante es además **el sitio donde vive el monto de verdad**: se registra una sola vez y todo lo demás (los pagos, la detracción, el lote, el asiento) lo mira de ahí en vez de volver a escribirlo.",
    ejemplo:
      "La factura de GRIJALVA TOURS por S/ 1,120 se registra una sola vez en Cuentas por Pagar. El adelanto, el pago, la detracción de S/ 112 y el lote de pago no repiten el monto: lo referencian.",
    ojo:
      "Un voucher de transferencia o una foto de WhatsApp **no es un comprobante**. El voucher prueba que salió plata; la factura prueba qué compraste y es lo único que te da crédito fiscal y sustento de gasto. Guarda los dos, pero no los confundas.",
    verTambien: ["factura", "boleta", "recibo_honorarios", "serie_numero", "regla_oro"],
  },

  factura: {
    clave: "factura",
    termino: "Factura",
    definicion:
      "Es el comprobante que se emite entre empresas con RUC. Muestra el IGV por separado, da derecho a crédito fiscal y sustenta el gasto para el Impuesto a la Renta.\nEs el comprobante normal de AFA, tanto para lo que cobra a sus clientes como para lo que le cobran sus proveedores.",
    ejemplo:
      "F001-00025 por un servicio de transporte de personal: S/ 949.15 de valor del servicio + S/ 170.85 de IGV = S/ 1,120 de total.",
    ojo:
      "Que esté emitida no significa que esté cobrada, ni que el servicio esté liquidado. Son estados distintos: mira el **estado administrativo** del lado del cliente y el **estado de pago** del lado del proveedor.",
    verTambien: ["comprobante", "boleta", "serie_numero", "igv", "estado_admin"],
  },

  boleta: {
    clave: "boleta",
    termino: "Boleta de venta",
    definicion:
      "Es el comprobante que se emite a un consumidor final, sin RUC.\nTe importa por lo que NO hace: una boleta no te da crédito fiscal, y para el Impuesto a la Renta solo se acepta hasta un tope bastante pequeño del total de tus compras.",
    ejemplo:
      "El conductor paga un lavado de S/ 60 y trae una boleta a su nombre. Ese IGV no se recupera. Con factura a nombre del RUC de AFA, sí.",
    ojo:
      "Es la fuga silenciosa más común en caja chica: peajes, lavados y repuestos menores que llegan con boleta. Pide factura siempre que se pueda, y ten claro que el tope de boletas aceptadas para renta lo fija la ley — cuánto te está costando de verdad, pregúntaselo a tu contador.",
    verTambien: ["factura", "credito_fiscal", "caja_chica", "comprobante"],
  },

  recibo_honorarios: {
    clave: "recibo_honorarios",
    termino: "Recibo por honorarios",
    definicion:
      "Es el comprobante que emite una **persona natural** que trabaja de forma independiente.\nDos diferencias que hay que tener claras: no lleva IGV (así que no te da crédito fiscal) y puede llevar retención de renta de cuarta categoría del 8 %.",
    ejemplo:
      "En la planilla de servicios de OSLO, 47 de las 108 filas traen recibo por honorarios y 61 traen factura. Al subirla, el ERP mira cuál de las dos columnas está llena y decide fila por fila cuál de los dos es, sin que nadie tenga que marcarlo a mano.",
    ojo:
      "No le sumes IGV a un recibo por honorarios ni esperes descontarlo: no existe. Y ojo con lo laboral: si la persona cumple horario, recibe órdenes y usa tu vehículo, un recibo por honorarios puede no ser suficiente para sustentar esa relación. Eso lo tiene que revisar tu contador o tu asesor laboral, no el sistema.",
    verTambien: ["retencion", "factura", "comprobante", "cuentas_por_pagar"],
  },

  nota_credito: {
    clave: "nota_credito",
    termino: "Nota de crédito",
    definicion:
      "Es el documento que corrige una factura o boleta que ya emitiste: la anula, le hace un descuento o registra una devolución.\nSiempre referencia al comprobante original y se emite con su propia serie.",
    ejemplo:
      "Emitiste F001-00025 por S/ 1,120 y el cliente demuestra que dos servicios no se hicieron. En vez de romper la factura, emites una nota de crédito con serie FC01 por S/ 200 referenciando F001-00025.",
    ojo:
      "Una factura emitida no se borra ni se “arregla”: se corrige con nota de crédito. Y si anulaste un servicio y nunca emitiste la nota, sigues debiendo el IGV de una factura que jamás vas a cobrar.",
    verTambien: ["factura", "registro_ventas", "serie_numero", "igv"],
  },

  guia_remision: {
    clave: "guia_remision",
    termino: "Guía de remisión",
    definicion:
      "Es el documento que acompaña el traslado de **bienes**: dice qué se mueve, de dónde a dónde y quién lo transporta.\nComo AFA mueve personas, casi nunca la emite; aparece solo cuando trasladas cosas.",
    ejemplo:
      "Llevar 40 trabajadores de Piura a la mina no necesita guía de remisión. Llevar un motor de repuesto de Lima al taller de la base, sí.",
    ojo:
      "No la confundas con el **manifiesto de pasajeros**, que es el listado de quién sube al bus y sale del propio servicio, con el botón “Abrir manifiesto” en Programación. Son documentos distintos, con finalidades distintas y ante autoridades distintas.",
    verTambien: ["comprobante", "factura"],
  },

  serie_numero: {
    clave: "serie_numero",
    termino: "Serie y número",
    definicion:
      "Es la matrícula de un comprobante: una serie (letras y números, como F001) y un número correlativo (00025), que juntos se escriben F001-00025.\nEs lo que hace único a cada comprobante y lo que evita registrar dos veces la misma factura.",
    ejemplo:
      "En el ERP las facturas de venta usan F001, las boletas B001 y las notas de crédito FC01. Del lado de compras, la combinación RUC del emisor + tipo + serie + número no se puede repetir: por eso, si subes dos veces la planilla de OSLO, la factura F002-00310 de GRIJALVA TOURS entra una sola vez.",
    ojo:
      "El número lleva ceros a la izquierda. “F001-25” y “F001-00025” son el mismo comprobante para ti, pero distintos para cualquier buscador o cruce. Escríbelo siempre completo, como está impreso.",
    verTambien: ["comprobante", "factura", "nota_credito", "registro_compras"],
  },

  // ── Contabilidad: cuándo se cuenta y dónde se anota ──────────────────────────

  devengado: {
    clave: "devengado",
    termino: "Devengado",
    definicion:
      "Es contar el ingreso o el gasto cuando **ocurre el hecho**, no cuando se mueve la plata.\nEs la forma en que la empresa lleva su contabilidad y su resultado mensual: el servicio del 28 de febrero es de febrero, cobres cuando cobres.",
    ejemplo:
      "El servicio del 28 de febrero por S/ 1,120 se devenga en febrero aunque el cliente pague el 15 de abril. En el resultado de febrero está el ingreso y también el combustible y los peajes de ese viaje.",
    ojo:
      "Es la razón por la que un mes puede mostrar utilidad y la cuenta bancaria estar seca: utilidad no es caja. Si quieres saber si te alcanza para pagar la planilla, mira lo percibido, no lo devengado.",
    verTambien: ["percibido", "periodo_contable", "cuentas_por_cobrar", "margen"],
  },

  percibido: {
    clave: "percibido",
    termino: "Percibido",
    definicion:
      "Es contar la plata cuando de verdad entra o sale de la cuenta. Es la vista de caja: qué tienes disponible hoy.\nEs lo que muestra Finanzas → pestaña Tesorería, mientras que el resultado del mes se mide por lo devengado.",
    ejemplo:
      "Esa misma factura de S/ 1,120 de febrero, cobrada el 15 de abril, es ingreso devengado de febrero y caja de abril. Y de los S/ 1,120, a tu cuenta comercial entraron S/ 1,008: los otros S/ 112 están en el Banco de la Nación.",
    ojo:
      "Antes de discutir una cifra con alguien, aclara cuál de las dos vistas estás mirando. La mitad de las discusiones sobre “cuánto ganamos este mes” son en realidad dos personas mirando devengado y percibido sin decirlo.",
    verTambien: ["devengado", "conciliacion_bancaria", "banco_nacion", "saldo"],
  },

  periodo_contable: {
    clave: "periodo_contable",
    termino: "Periodo contable",
    definicion:
      "Es el mes al que pertenece cada movimiento, escrito como año-mes (por ejemplo 2026-02).\nMientras el mes está en curso se le siguen cargando cosas; una vez que tu contador lo declaró, no deberían entrar movimientos nuevos a ese mes.",
    ejemplo:
      "En Contabilidad eliges el mes en el selector de arriba y las cifras del mes se calculan para él: el IGV de ventas, el de compras y la diferencia a pagar, y la depreciación que se registra con el botón “Depreciar”.",
    ojo:
      "Si en abril te llega una factura de febrero, no la fuerces a febrero porque ese mes ya se declaró. Hay reglas específicas sobre en qué periodo se anota una factura atrasada y desde cuándo puedes usar su crédito fiscal: eso lo decide tu contador, no el sistema.",
    verTambien: ["devengado", "registro_compras", "asiento", "amortizacion"],
  },

  asiento: {
    clave: "asiento",
    termino: "Asiento contable",
    definicion:
      "Es el registro contable de un hecho, escrito en el lenguaje de las cuentas y siempre con dos lados que suman igual.\nEn este ERP los asientos **no se teclean**: salen solos de la factura, del comprobante de compra o de la depreciación del mes, y cada uno se queda apuntando al documento del que salió.",
    ejemplo:
      "Con el botón “Generar asientos faltantes” de Contabilidad, la factura F001-00025 de S/ 1,120 produce un asiento que carga 1212 Facturas por cobrar S/ 1,120 y abona 7041 Prestación de servicios S/ 949.15 más 40111 IGV S/ 170.85.",
    ojo:
      "Si los dos lados no suman igual, el sistema no lo da por bueno: el asiento se queda en borrador. Y como salen del documento, un número mal puesto se corrige **en el documento** y se vuelven a generar los asientos; nunca se retoca el asiento a mano, porque entonces el documento y la contabilidad dicen cosas distintas.",
    verTambien: ["debe_haber", "plan_cuentas", "periodo_contable", "regla_oro"],
  },

  debe_haber: {
    clave: "debe_haber",
    termino: "Debe y haber (partida doble)",
    definicion:
      "Es la mecánica de la contabilidad: cada operación se anota en dos sitios, uno al debe (izquierda) y otro al haber (derecha), y los dos lados tienen que sumar lo mismo.\nSirve para que nada se registre a medias: si algo entró, tiene que haber salido de algún lado.",
    ejemplo:
      "Así se anota el pago de una factura de GRIJALVA TOURS de S/ 1,120 con S/ 112 de detracción: al debe va la deuda que desaparece (4212 Facturas por pagar S/ 1,120) y al haber van los dos sitios de donde salió la plata (banco S/ 1,008 + cuenta de detracciones S/ 112). Cuadra, aunque el BCP solo haya movido S/ 1,008.",
    ojo:
      "“Debe” no significa que debas plata: es solo el lado izquierdo. En una cuenta de banco el debe suma y en una cuenta de deuda el debe resta. Es de las palabras peor elegidas de la contabilidad y confunde a todo el mundo la primera vez.",
    verTambien: ["asiento", "plan_cuentas", "detraccion"],
  },

  plan_cuentas: {
    clave: "plan_cuentas",
    termino: "Plan de cuentas",
    definicion:
      "Es la lista numerada de cajones donde entra cada movimiento, para que todo el mundo llame igual a lo mismo. En Perú se usa el Plan Contable General Empresarial.\nEl ERP trae los cajones que usa un transportista, no el plan completo.",
    ejemplo:
      "7041 ingresos por servicios de transporte, 631 servicios de terceros (lo que te cobra GRIJALVA TOURS), 634 mantenimiento, 656 combustible, 334 unidades de transporte, 6811 depreciación, 40111 IGV.",
    ojo:
      "El plan que trae el ERP es un subconjunto pensado para que los asientos automáticos funcionen. Si tu contador trabaja con un plan más detallado, cotéjenlo antes de dar por buenos los reportes contables: puede que él espere subcuentas que aquí no existen.",
    verTambien: ["asiento", "debe_haber", "centro_costo"],
  },

  registro_compras: {
    clave: "registro_compras",
    termino: "Registro de Compras",
    definicion:
      "Es el libro donde se anotan, en orden, todas las facturas que **recibes**. De ahí sale el crédito fiscal del mes.\nEn el ERP lo alimentan los documentos de compra que registras o importas en Cuentas por Pagar.",
    ejemplo:
      "En Contabilidad, la pestaña Compras lista las facturas de proveedor que ya están registradas (emisor, comprobante, fecha, subtotal, IGV y total). Cuánto IGV puedes descontar en un mes concreto lo ves en la pestaña IGV, eligiendo antes el mes en el selector de arriba.",
    ojo:
      "Una factura pagada pero no anotada aquí no te da crédito fiscal. Y si esa compra tenía detracción sin depositar, el crédito recién corre desde el mes del depósito. Hoy este libro se presenta a SUNAT electrónicamente y lo hace tu contador: el ERP le entrega los datos ordenados, no presenta nada por ti.",
    verTambien: ["credito_fiscal", "igv", "detraccion", "periodo_contable", "cuentas_por_pagar"],
  },

  registro_ventas: {
    clave: "registro_ventas",
    termino: "Registro de Ventas",
    definicion:
      "Es el mismo libro, pero del lado de lo que tú emites: todas las facturas, boletas y notas de crédito de tus ventas.\nDe ahí sale el IGV que debes por el mes.",
    ejemplo:
      "Si las facturas de febrero suman S/ 13,400 de IGV y tus compras del mes traen S/ 8,900, a SUNAT le pagas S/ 4,500.",
    ojo:
      "Las notas de crédito también van aquí, restando. Si anulaste un servicio y no emitiste la nota, el IGV de esa factura sigue apareciendo como deuda tuya aunque nunca vayas a cobrarla.",
    verTambien: ["igv", "nota_credito", "factura", "cuentas_por_cobrar"],
  },

  // ── Deudas, cobros y plazos ─────────────────────────────────────────────────

  cuentas_por_pagar: {
    clave: "cuentas_por_pagar",
    termino: "Cuentas por pagar (CxP)",
    definicion:
      "Es lo que le debes a tus proveedores, factura por factura, con su saldo y su fecha de vencimiento.\nEn este ERP no hay una lista de deudas aparte: **la cuenta por pagar es el propio comprobante de compra**, y su saldo se calcula restándole los pagos que se le aplicaron.",
    ejemplo:
      "En Cuentas por Pagar ves la factura de GRIJALVA TOURS por S/ 1,120. Si tiene un pago aplicado de S/ 500, el saldo que muestra es S/ 620.",
    ojo:
      "Una factura sigue apareciendo aquí hasta que su saldo llega a cero, y el saldo solo baja cuando el pago **existe y está aplicado a esa factura**. Si ya le transferiste al proveedor pero nadie registró el pago en el ERP, la deuda sigue viva en pantalla: no está mal el sistema, falta el registro.",
    verTambien: ["saldo", "estado_pago", "estado_aprobacion", "aging", "lote_pago"],
  },

  cuentas_por_cobrar: {
    clave: "cuentas_por_cobrar",
    termino: "Cuentas por cobrar (CxC)",
    definicion:
      "Es lo que te deben tus clientes: las facturas emitidas que todavía no te han pagado, con su antigüedad.\nEs la contracara de las cuentas por pagar y la mejor foto de tu caja futura.",
    ejemplo:
      "Doce facturas emitidas en febrero por S/ 74,000, de las cuales S/ 31,000 ya vencieron hace más de 30 días. Esa es la plata que hay que salir a cobrar esta semana.",
    ojo:
      "Un servicio que todavía está “por liquidar” no es cuenta por cobrar: no hay nada que cobrar hasta que se emite la factura. Si tu cartera se ve pequeña, revisa primero cuántos servicios finalizados están esperando liquidación.",
    verTambien: ["aging", "vencimiento", "estado_admin", "liquidacion_cliente", "saldo"],
  },

  saldo: {
    clave: "saldo",
    termino: "Saldo",
    definicion:
      "Es lo que falta pagar (o cobrar) de un comprobante: total menos lo ya pagado.\nEn el ERP el saldo **nunca se guarda**, se calcula en el momento a partir de los pagos aplicados. Por eso no puede quedarse desactualizado.",
    ejemplo:
      "Factura de S/ 1,120 con un pago aplicado de S/ 500: el saldo es S/ 620. Cuando se aplique el resto, será cero y la factura dejará de aparecer como pendiente.",
    ojo:
      "En Cuentas por Pagar hay dos columnas seguidas que se parecen y no son lo mismo: **A cancelar** y **Saldo**. El saldo es lo que falta de la deuda total; “a cancelar” es lo que sale por el banco después de restar adelantos, detracción y retención. En una factura de S/ 1,120 con S/ 112 de detracción, transfieres S/ 1,008 pero la deuda que se extingue es de S/ 1,120: los otros S/ 112 los pagaste al Banco de la Nación.",
    verTambien: ["estado_pago", "cuentas_por_pagar", "adelanto", "detraccion", "regla_oro"],
  },

  aging: {
    clave: "aging",
    termino: "Aging (antigüedad de la deuda)",
    definicion:
      "Es agrupar las deudas según cuánto llevan vencidas, para ver de un vistazo qué es urgente. En Cuentas por Pagar cada factura lleva su pastilla de color: **Vigente** (todavía no vence), **1-30 d**, **31-60 d**, **61-90 d** y **+90 d**.\nSe usa igual para lo que te deben y para lo que debes.",
    ejemplo:
      "Una factura que venció hace 45 días sale con la pastilla 31-60 d. Si lo que se acumula en +90 d crece mes a mes, tienes un problema de cobranza, no de facturación.",
    ojo:
      "Los días se cuentan desde la **fecha de vencimiento**, no desde la emisión. Y cuidado con las facturas sin fecha de vencimiento: como no hay desde cuándo contar, salen pintadas de verde como “Vigente” aunque lleven medio año sin pagarse. No es que el sistema mienta, es que le falta el dato. Pon siempre la fecha, aunque sea estimada.",
    verTambien: ["vencimiento", "cuentas_por_cobrar", "cuentas_por_pagar", "saldo"],
  },

  vencimiento: {
    clave: "vencimiento",
    termino: "Fecha de vencimiento",
    definicion:
      "Es la fecha límite para pagar (o cobrar) un comprobante. Normalmente sale del plazo acordado: contado, 15, 30 o 60 días desde la emisión.\nEs el dato que hace funcionar el aging y las alertas de vencidos.",
    ejemplo:
      "Una factura emitida el 3 de marzo a 30 días vence el 2 de abril. A partir del 3 de abril deja de estar “Vigente” y pasa a la pastilla 1-30 d.",
    ojo:
      "No la confundas con la fecha de emisión ni con la fecha del servicio: en la planilla de OSLO las tres pueden ser distintas, y casi la mitad de las filas no traen ninguna fecha propia. Por eso el importador te pide una fecha de referencia en vez de inventarla en silencio.",
    verTambien: ["aging", "cuentas_por_pagar", "cuentas_por_cobrar"],
  },

  adelanto: {
    clave: "adelanto",
    termino: "Adelanto (a cuenta del proveedor)",
    definicion:
      "Es la plata que le entregas a un proveedor antes de terminar de pagar su factura. Al registrar el comprobante hay dos casillas, **Adelanto 1** y **Adelanto 2**, porque así llega la planilla que usa AFA.\nSe restan de la columna “A cancelar”: lo que finalmente le transfieres es lo que queda.",
    ejemplo:
      "ALVAREZ FARFAN factura S/ 960 y ya le habías dado S/ 400 la semana del servicio. Lo que queda por transferirle es 960 − 400 de adelanto − 96 de detracción = S/ 464.",
    ojo:
      "El adelanto anotado en la casilla baja la columna “A cancelar”, pero **no baja el saldo por sí solo**: el saldo solo se mueve cuando existe un pago registrado y aplicado a esa factura. Si el adelanto está solo como número en la casilla y nunca se registró como pago, la factura seguirá mostrando el saldo completo. Registra los dos y las dos columnas contarán la misma historia.",
    verTambien: ["anticipo", "saldo", "estado_pago", "cuentas_por_pagar"],
  },

  anticipo: {
    clave: "anticipo",
    termino: "Anticipo",
    definicion:
      "Es plata cobrada o pagada **antes** de que el servicio se preste. Del lado del cliente, lo que te adelantan para arrancar un contrato; del lado del proveedor, lo que ya le entregaste y se descuenta al liquidarle el periodo.",
    ejemplo:
      "GRIJALVA TOURS hizo 18 servicios en marzo por S/ 19,200. Como en la quincena le habías anticipado S/ 3,000, la liquidación del proveedor arranca de S/ 19,200 y descuenta esos S/ 3,000 antes de calcular lo que se le transfiere.",
    ojo:
      "Si un cliente te anticipa plata, eso todavía **no es ingreso**: es una obligación, porque le debes el servicio. Se vuelve ingreso cuando el servicio se presta. Y si emitiste comprobante por el anticipo, cómo se aplica luego a la factura final tiene reglas propias: confírmalo con tu contador.",
    verTambien: ["adelanto", "liquidacion_proveedor", "liquidacion_cliente", "devengado"],
  },

  // ── Banco ───────────────────────────────────────────────────────────────────

  conciliacion_bancaria: {
    clave: "conciliacion_bancaria",
    termino: "Conciliación bancaria",
    definicion:
      "Es comparar, línea por línea, lo que dice el banco con lo que dice el ERP, para que no quede ni un movimiento sin explicación.\nEs lo que convierte “creo que pagamos” en “esta salida de S/ 1,008 corresponde a esta factura”.",
    ejemplo:
      "Subes el movimiento del BCP del 1 al 15 de marzo: el ERP casa 38 de 45 cargos automáticamente y te deja 7 sin identificar por S/ 3,240 para revisar.",
    ojo:
      "Solo el casado por **número de operación** se concilia solo, porque es exacto. El casado por importe y fecha se **propone** y lo confirmas tú: en transporte dos servicios del mismo precio el mismo día son la norma, y aceptar a ciegas cierra la factura equivocada — que es peor que no conciliar, porque después nadie sospecha del error.",
    verTambien: ["extracto_bancario", "nro_operacion", "fuga_bancaria", "estado_conciliacion"],
  },

  extracto_bancario: {
    clave: "extracto_bancario",
    termino: "Extracto bancario",
    definicion:
      "Es el movimiento de tu cuenta descargado del banco: fecha, número de operación, glosa, cargo, abono y saldo.\nEs la única fuente que no discute: lo que dice el banco es lo que pasó.",
    ejemplo:
      "Descargas de Telecrédito el movimiento del mes en Excel. En Cuentas por Pagar → Conciliación eliges primero la cuenta (mientras no la elijas, el botón está apagado) y lo subes con “Importar extracto”.",
    ojo:
      "Puedes re-subir rangos que se solapan sin miedo a duplicar: cada movimiento tiene una huella única (cuenta, fecha, número de operación, importes y glosa) y el que ya estaba no entra dos veces. Lo que sí importa es elegir bien la cuenta: el mismo número de operación puede repetirse entre cuentas distintas.",
    verTambien: ["conciliacion_bancaria", "telecredito", "nro_operacion", "fuga_bancaria"],
  },

  nro_operacion: {
    clave: "nro_operacion",
    termino: "Número de operación",
    definicion:
      "Es el código que el banco le pone a cada movimiento y que aparece en el voucher de la transferencia.\nEs la llave de oro de la conciliación: si el ERP lo tiene guardado, casa ese cargo del banco con esa factura de forma exacta y automática.",
    ejemplo:
      "Pagas el lote de la semana y el banco devuelve la operación 00123456. Al pulsar “Confirmar pago del lote” escribes ese número en el campo “N° de operación” y queda guardado en cada factura del lote. Cuando subas el extracto del mes, esos cargos se concilian solos.\nSi las facturas vienen de una planilla, el número también entra si la hoja trae su columna de nº de operación.",
    ojo:
      "Anotarlo cuesta cinco segundos y ahorra horas. Sin él, el ERP solo puede proponer coincidencias por importe y fecha, que alguien tiene que revisar a mano una por una — y ese alguien siempre acaba siendo la persona con menos tiempo.",
    verTambien: ["conciliacion_bancaria", "extracto_bancario", "estado_pago", "telecredito"],
  },

  telecredito: {
    clave: "telecredito",
    termino: "Telecrédito (BCP)",
    definicion:
      "Es la banca por internet para empresas del BCP. En el circuito del ERP se usa para dos cosas: descargar el extracto de la cuenta y subir un archivo de pagos masivos.\nEse archivo hace que el banco ejecute muchas transferencias de una sola vez, en lugar de teclearlas una por una.",
    ejemplo:
      "Armas el lote LP-2026-000014 con 23 facturas aprobadas por S/ 41,300, descargas el archivo desde el ERP y lo cargas en Telecrédito: el banco hace los 23 abonos.",
    ojo:
      "El archivo que genera el ERP es un CSV genérico. **Cotéjalo una sola vez contra la estructura que pide tu convenio con el BCP** antes de usarlo en producción: cada empresa tiene su plantilla y el banco rechaza el archivo entero si el orden de las columnas no calza.",
    verTambien: ["lote_pago", "cci", "extracto_bancario", "conciliacion_bancaria"],
  },

  lote_pago: {
    clave: "lote_pago",
    termino: "Lote de pago",
    definicion:
      "Es un grupo de obligaciones ya aprobadas que se pagan juntas en un solo archivo al banco. Recorre cuatro estados —Borrador → Aprobado → En Telecrédito → Pagado— y también puede anularse.\nSirve para pagar una vez por semana de forma ordenada, en vez de transferir a demanda.",
    ejemplo:
      "El lote LP-2026-000014 junta 23 facturas de proveedores por S/ 41,300. Gerencia lo aprueba, se pulsa “Descargar archivo Telecrédito”, se carga ese archivo en el banco y al día siguiente se cierra con “Confirmar pago del lote”.",
    ojo:
      "Al confirmar el pago, el ERP emite **un pago por cada línea** del lote y lo aplica a su factura, para que el saldo de cada proveedor quede correcto. No es un sello global: si el lote se queda en “en Telecrédito” y nadie confirma, las facturas seguirán mostrando saldo aunque el banco ya haya abonado.",
    verTambien: ["telecredito", "estado_aprobacion", "estado_pago", "cci", "cuentas_por_pagar"],
  },

  fuga_bancaria: {
    clave: "fuga_bancaria",
    termino: "Fuga bancaria (Regla Cero Fugas)",
    definicion:
      "Es un cargo en tu cuenta que el ERP no sabe justificar: salió plata y no hay factura, gasto ni pago registrado que la explique.\nLa pantalla de Conciliación pone esa cifra en rojo arriba de todo, bajo el rótulo “Regla Cero Fugas”, porque es la pregunta más importante de esa pantalla: ¿por qué salió esto?",
    ejemplo:
      "En el rango que subiste quedan 7 cargos sin identificar por S/ 3,240. Puede ser un pago que nadie registró, una comisión, o algo que hay que investigar hoy mismo.",
    ojo:
      "No toda fuga es un robo. Comisiones, portes, mantenimiento de cuenta e ITF son cargos legítimos que no cruzan con ninguna factura. El casado automático ya aparta solos los que reconoce por su descripción; a los demás les das “Marcar como ignorado (comisión / ITF)” y dejan de sonar. La gracia es que lo que quede en rojo sea de verdad lo que no tiene explicación.",
    verTambien: ["conciliacion_bancaria", "extracto_bancario", "nro_operacion", "regla_oro"],
  },

  // ── Caja chica ──────────────────────────────────────────────────────────────

  caja_chica: {
    clave: "caja_chica",
    termino: "Caja chica",
    definicion:
      "Es la bolsa de efectivo que le entregas a una persona para los gastos chicos del día a día: peaje, lavado, movilidad, viáticos, un repuesto menor.\nEn el ERP son tres cosas encadenadas: el **fondo** (la bolsa de cada persona), la **rendición** (cada ciclo de entrega → gastos → devolución) y los **gastos** (un comprobante por fila, con su foto).",
    ejemplo:
      "Un supervisor tiene fondo de S/ 500. Se le entregan los S/ 500, rinde 14 comprobantes por S/ 437.50 y devuelve S/ 62.50 en efectivo.",
    ojo:
      "El sistema **no deja entregar dinero nuevo a quien tiene una rendición abierta o vencida**, ni por encima del tope que tenga puesto ese fondo. Esa regla vive dentro de la base de datos, no en la pantalla: no se puede saltar desde ningún módulo ni desde la app del conductor. Si hay que entregar igual, primero se cierra la rendición vieja. Ojo también con las fotos de los comprobantes: se guardan en un depósito privado (un ticket de peaje trae placa y ubicación), no en una carpeta pública.",
    verTambien: ["entrega_a_rendir", "rendicion", "reposicion", "boleta", "costo_directo"],
  },

  entrega_a_rendir: {
    clave: "entrega_a_rendir",
    termino: "Entrega a rendir",
    definicion:
      "Es la plata que sale de caja o del banco hacia una persona y que **todavía no es un gasto**: es un encargo.\nMientras no rinda, esa persona te debe el dinero o los comprobantes que lo sustenten.",
    ejemplo:
      "Le entregas S/ 500 a un supervisor un lunes. El fondo dice 7 días para rendir, así que la fecha límite queda fijada para el lunes siguiente.",
    ojo:
      "Entregar no es gastar. El gasto aparece recién cuando llega el comprobante. Si contabilizas la entrega como gasto y después también cargas los tickets, duplicas el costo del mes.",
    verTambien: ["caja_chica", "rendicion", "reposicion", "regla_oro"],
  },

  rendicion: {
    clave: "rendicion",
    termino: "Rendición",
    definicion:
      "Es el documento donde la persona da cuenta de en qué usó el dinero, comprobante por comprobante, y devuelve el vuelto.\nPasa por cuatro estados: **Abierta** (tiene el dinero y está gastando) → **Por revisar** (la cerró y la mandó) → **Observada**, si le falta algo y se le devuelve → **Liquidada**, aprobada y cuadrada. Si se abrió por error, también puede quedar **Anulada**.",
    ejemplo:
      "Rendición con 14 comprobantes por S/ 437.50 sobre S/ 500 asignados: mientras no devuelva el efectivo, muestra saldo pendiente de S/ 62.50.",
    ojo:
      "Lo rendido y el saldo pendiente **no se escriben a mano en ningún campo**: se suman solos desde los comprobantes cargados. Si el número no te cuadra, falta o sobra un comprobante — no es que el sistema haya calculado mal. Revisa la lista de comprobantes de esa rendición antes de discutir la cifra.",
    verTambien: ["caja_chica", "entrega_a_rendir", "reposicion", "estado_aprobacion", "regla_oro"],
  },

  reposicion: {
    clave: "reposicion",
    termino: "Reposición de fondo",
    definicion:
      "Es volver a llenar el fondo hasta su monto de siempre, una vez que la rendición anterior quedó cerrada.\nEn el ERP no hay un botón que diga “reponer”: la reposición es sencillamente la siguiente entrega, con **+ Entregar dinero** en Caja Chica → Rendiciones. Y solo la deja hacer cuando la rendición anterior está cerrada.",
    ejemplo:
      "Fondo de S/ 500. Rindió S/ 437.50 y devolvió S/ 62.50, así que la siguiente entrega es de S/ 437.50 y vuelve a tener sus S/ 500 en la mano.",
    ojo:
      "Se repone **lo gastado**, no el monto del fondo. Si le entregas S/ 500 encima de lo que le quedaba, el fondo crece sin que nadie lo haya decidido, y a fin de año tienes mucho más efectivo en la calle del que creías.",
    verTambien: ["caja_chica", "rendicion", "entrega_a_rendir"],
  },

  // ── Servicio, liquidación y costo ───────────────────────────────────────────

  liquidacion_cliente: {
    clave: "liquidacion_cliente",
    termino: "Liquidación al cliente",
    definicion:
      "Es el documento donde cierras cuánto se le va a cobrar de verdad al cliente por los servicios de un periodo: los servicios hechos, más los **adicionales** que se autorizaron (horas de espera, kilómetros de más, un peaje que no estaba en la tarifa), menos **penalidades** y **descuentos**.\nCuando se aprueba, es lo que se convierte en factura.",
    ejemplo:
      "Los 62 servicios del mes de un cliente corporativo se consolidan en una sola valorización, se aprueban y salen en una sola factura, en vez de 62 facturas sueltas.",
    ojo:
      "Es el paso que impide facturar de memoria. Mientras la liquidación no esté aprobada, la cifra que ves en el servicio es la **pactada**, no la definitiva: los adicionales del mes todavía no están dentro.",
    verTambien: ["conformidad", "factura", "estado_admin", "cuentas_por_cobrar", "anticipo"],
  },

  liquidacion_proveedor: {
    clave: "liquidacion_proveedor",
    termino: "Liquidación al proveedor",
    definicion:
      "Es el espejo de la anterior, del lado de quien te presta el servicio: agrupa lo que hizo un tercero en un periodo, aplica adicionales, penalidades y descuentos, calcula la detracción y resta anticipos.\nCuando se aprueba, nace la cuenta por pagar.",
    ejemplo:
      "GRIJALVA TOURS hizo 18 servicios en marzo por S/ 19,200. La liquidación descuenta S/ 3,000 de anticipos y una penalidad de S/ 300 por una unidad que llegó tarde, y de ahí sale lo que se le debe.",
    ojo:
      "Solo aplica a servicios **tercerizados**. Un servicio hecho con tu flota y tu conductor no genera liquidación de proveedor: su costo son el combustible, el mantenimiento y la caja chica cargados a ese servicio.",
    verTambien: ["tercerizado", "cuentas_por_pagar", "detraccion", "anticipo", "estado_aprobacion"],
  },

  conformidad: {
    clave: "conformidad",
    termino: "Conformidad del cliente",
    definicion:
      "Es el visto bueno del cliente sobre la liquidación, antes de facturar.\nEl ERP le manda un enlace: entra sin usuario ni contraseña, ve el resumen del periodo y, si quiere, el documento completo tal como se imprime (“Ver el documento completo”), y desde ahí aprueba u observa dejando su nombre y su cargo.",
    ejemplo:
      "Envías la valorización de marzo por correo o WhatsApp. El jefe de operaciones del cliente abre el enlace, escribe su nombre y su cargo y pulsa “Doy conformidad”. Si algo no le cuadra, pulsa “Tengo una observación” y dice qué revisar. En los dos casos queda guardado quién respondió y cuándo.",
    ojo:
      "La conformidad no es la factura ni el pago. Es la prueba de que el cliente aceptó el importe — que es exactamente lo que te van a pedir tres meses después, cuando la factura se atrase y nadie recuerde qué se acordó.",
    verTambien: ["liquidacion_cliente", "estado_admin", "factura", "cuentas_por_cobrar"],
  },

  tercerizado: {
    clave: "tercerizado",
    termino: "Servicio tercerizado",
    definicion:
      "Es un servicio que no hiciste con tu flota, sino con la unidad de otra empresa o de un tercero.\nTe importa porque tiene dos historias de dinero a la vez: lo que le cobras al cliente y lo que te cobra el tercero.",
    ejemplo:
      "El 12 de marzo faltó una unidad y lo cubrió GRIJALVA TOURS: le cobras S/ 1,120 al cliente y el tercero te factura S/ 900. El margen de ese servicio es S/ 220, no S/ 1,120.",
    ojo:
      "Los dos lados se cierran por separado y a distinto ritmo. El lado del cliente recorre Por liquidar → Liquidada → Facturada → Cobrada; el lado del proveedor recorre Por conciliar → Conciliada → Por pagar → Pagada. Que el cliente ya te haya pagado no significa que tú ya le pagaste al tercero, y el ERP lleva las dos cuentas aparte a propósito.",
    verTambien: ["liquidacion_proveedor", "estado_admin", "estado_proveedor", "margen_real", "costo_directo"],
  },

  costo_directo: {
    clave: "costo_directo",
    termino: "Costo directo",
    definicion:
      "Es el costo que puedes atribuir a un servicio concreto porque lleva su número: el combustible de ese viaje, los peajes que pagó el conductor, el mantenimiento cargado a esa reserva, la factura del tercero que lo cubrió.\nEs lo único que el ERP usa para calcular el margen real de un servicio.",
    ejemplo:
      "El servicio del 12 de marzo con la CWQ-400 costó S/ 180 de combustible + S/ 42 de peajes rendidos en caja chica = S/ 222 de costo directo.",
    ojo:
      "La planilla administrativa, el alquiler de la oficina, el seguro y los neumáticos **no** son costo directo de un servicio: son costo del negocio o del vehículo. Repartirlos entre servicios es una decisión (ver prorrateo), no un dato, y el ERP no la toma por ti.",
    verTambien: ["margen_real", "prorrateo", "centro_costo", "caja_chica", "amortizacion"],
  },

  margen: {
    clave: "margen",
    termino: "Margen",
    definicion:
      "Es lo que queda de un servicio después de restarle sus costos.\nSirve para comparar rutas, clientes y unidades: cuál te deja plata y cuál te la come.",
    ejemplo:
      "Cobras S/ 1,120 por un servicio que te costó S/ 222 en combustible y peajes: el margen es S/ 898, un 80 %.",
    ojo:
      "Ese margen es **antes** de la planilla, la oficina, el seguro, los neumáticos y la depreciación del bus. Un margen alto servicio por servicio no significa que el mes cierre en ganancia: son dos preguntas distintas.",
    verTambien: ["margen_real", "costo_directo", "prorrateo", "devengado"],
  },

  margen_real: {
    clave: "margen_real",
    termino: "Margen real",
    definicion:
      "Es el margen calculado con lo que de verdad se registró contra ese servicio, no con lo que se supone que cuesta.\nEs lo que muestra Gastos → pestaña **Rentabilidad por servicio**: lo que le cobras al cliente menos los egresos que llevan el número de esa reserva.",
    ejemplo:
      "Dos servicios de S/ 1,120 el mismo día. El propio dejó S/ 898. El que cubrió GRIJALVA TOURS dejó S/ 220, porque su factura fue de S/ 900. Mismo precio de venta, negocio completamente distinto.",
    ojo:
      "El margen real solo es de fiar si los gastos se registraron con el número del servicio. Un tanqueo cargado a la placa pero sin servicio hace que ese viaje parezca más rentable de lo que fue. Si un servicio te sale con margen sospechosamente alto, lo primero que hay que mirar es cuántos egresos tiene enganchados.",
    verTambien: ["costo_directo", "margen", "centro_costo", "tercerizado", "regla_oro"],
  },

  prorrateo: {
    clave: "prorrateo",
    termino: "Prorrateo",
    definicion:
      "Es repartir entre varios servicios un costo que no es de uno solo, usando algún criterio: kilómetros, horas, número de servicios o ingresos.\nSirve para saber cuánto cuesta “de verdad” un viaje cuando le sumas su parte de los costos compartidos.",
    ejemplo:
      "S/ 4,800 de neumáticos de la CWQ-400 que rinden 60,000 km salen a S/ 0.08 por km. Un servicio de 180 km consume S/ 14.40 de neumáticos.",
    ojo:
      "El ERP **a propósito no prorratea solo**. El criterio de reparto es una decisión contable, no un dato, y cambiarlo cambia qué cliente o qué ruta parece rentable. Defínelo con tu contador, escríbelo, y aplícalo siempre igual: lo peor es cambiar de criterio a mitad de año y comparar meses que no son comparables.",
    verTambien: ["costo_directo", "centro_costo", "amortizacion", "margen_real"],
  },

  centro_costo: {
    clave: "centro_costo",
    termino: "Centro de costo",
    definicion:
      "Es la etiqueta que dice a qué parte del negocio pertenece un gasto: una unidad, un servicio, un proveedor.\nEn este ERP no hay un campo que se llame así: su trabajo lo hacen los dos desplegables del bloque **“Vincular a”** que aparece al registrar un gasto — **Reserva / Servicio** y **Vehículo** — y el proveedor. Eso es lo que permite después preguntar “cuánto me costó esta unidad este año” o “cuánto me dejó este servicio”.",
    ejemplo:
      "Registras un mantenimiento y en “Vincular a” eliges la placa CWQ-400: ese costo pasa a sumar en el acumulado de esa unidad. Si lo dejas en “Sin vehículo”, el gasto entra al total del mes y ya no hay forma de saber de qué bus era.",
    ojo:
      "Los dos desplegables vienen en “Sin reserva” y “Sin vehículo”, y esa es la razón número uno por la que los reportes por unidad o por servicio salen incompletos. Elegirlos cuesta un clic al registrar y es prácticamente imposible de reconstruir seis meses después.",
    verTambien: ["costo_directo", "prorrateo", "margen_real", "plan_cuentas"],
  },

  amortizacion: {
    clave: "amortizacion",
    termino: "Amortización / depreciación",
    definicion:
      "Es repartir el costo de algo que dura varios años a lo largo de su vida útil, en vez de cargarlo entero el mes que lo compraste.\nEn vehículos y equipos se llama depreciación: el ERP calcula una cuota mensual con (valor de compra − valor residual) ÷ meses de vida útil, y la registra en el periodo.",
    ejemplo:
      "Un bus de S/ 240,000 con 60 meses de vida útil deprecia S/ 4,000 al mes. Los neumáticos van por otro camino: se amortizan por kilómetro recorrido, porque su desgaste depende del uso y no del calendario.",
    ojo:
      "Comprar el bus no es un gasto del mes: es un activo que se va gastando. Las tasas máximas que acepta SUNAT las fija la ley — para unidades de transporte terrestre hoy es 20 % anual, que coincide con los 60 meses que el ERP trae por defecto — pero qué tasa y qué vida útil corresponden a cada activo tuyo confírmalo con tu contador.",
    verTambien: ["periodo_contable", "asiento", "prorrateo", "plan_cuentas"],
  },

  // ── Los tres semáforos + el ciclo del servicio + la regla que ordena todo ────

  estado_pago: {
    clave: "estado_pago",
    termino: "Estado de pago (Impaga · Parcial · Pagada)",
    definicion:
      "Responde **una sola pregunta: ¿ya salió la plata?**\nNo se escribe a mano: se calcula comparando el total del comprobante con los pagos que se le aplicaron. **Impaga** = no se ha pagado nada. **Parcial** = se pagó una parte. **Pagada** = el saldo llegó a cero.",
    ejemplo:
      "Factura de GRIJALVA TOURS por S/ 1,120. Sin pagos aplicados → impaga. Con un pago de S/ 620 → parcial. Con S/ 1,120 aplicados → pagada.",
    ojo:
      "Es la pregunta favorita del proveedor y la fuente del malentendido más común: **estar aprobada no la vuelve pagada**. Y si ya le transferiste pero aquí sigue “impaga”, no es un error del sistema: falta registrar ese pago y aplicarlo a esa factura. El estado es un reflejo de los pagos, no un interruptor.",
    verTambien: ["estado_aprobacion", "estado_conciliacion", "saldo", "lote_pago", "regla_oro"],
  },

  estado_aprobacion: {
    clave: "estado_aprobacion",
    termino: "Estado de aprobación (Pendiente · Aprobada · En lote · Rechazada)",
    definicion:
      "Responde otra pregunta distinta: **¿gerencia dio el visto bueno para que esto se pague?**\nEs la puerta de control del gasto: nada entra a un lote de pago sin pasar por aquí. En la columna “Aprobación” de Cuentas por Pagar verás **Pendiente** (todavía nadie lo revisó), **Aprobada** (sí, esto se debe y se va a pagar), **En lote** (ya está dentro de un archivo de pago) o **Rechazada** (no se paga tal como está).",
    ejemplo:
      "Llegan 41 facturas del mes: gerencia aprueba 38, rechaza 2 por falta de sustento y deja 1 pendiente hasta que le manden el detalle del servicio. Las 38 aprobadas entran al lote LP-2026-000014 y su pastilla pasa a “En lote”.",
    ojo:
      "**Aprobado no es pagado.** Es literalmente el malentendido más caro de todo el circuito de pagos: el proveedor pregunta si su factura está aprobada, escucha que sí, entiende que le pagaron, y en realidad todavía no ha salido un sol. Este semáforo y el de pago corren en paralelo y ninguno manda sobre el otro: una factura puede estar aprobada y sin pagar, o pagada y con la detracción todavía pendiente de depositar.",
    verTambien: ["estado_pago", "estado_conciliacion", "lote_pago", "liquidacion_proveedor"],
  },

  estado_conciliacion: {
    clave: "estado_conciliacion",
    termino: "Estado de conciliación (pendiente · conciliado · con diferencia · anulado)",
    definicion:
      "Responde la tercera pregunta: **¿el comprobante cuadra con lo que realmente se recibió?**\nEs la revisión del papel contra la realidad: que la factura corresponda a algo que de verdad pasó, en la cantidad y al precio que se pactó. Es una marca del comprobante, aparte de si está aprobado y aparte de si está pagado.",
    ejemplo:
      "En Contabilidad → Compras subes la factura del grifo (el XML o una foto). Si el ERP encuentra la carga de combustible que ya estaba registrada con esa placa, esa fecha y ese monto, deja la factura como **conciliada** y no la duplica. Si no encuentra con qué casarla, la deja **pendiente** para que alguien la revise.",
    ojo:
      "Dos advertencias.\nLa primera: en el ERP hay **dos conciliaciones distintas** y se confunden todo el tiempo. Esta es la del comprobante contra lo recibido (¿me están cobrando lo que me prestaron?). La otra es la conciliación bancaria: el movimiento del banco contra el pago registrado (¿esta salida de plata a qué corresponde?). Un documento puede estar conciliado y su pago seguir sin aparecer en el extracto.\nLa segunda: el ERP hace esta comprobación solo con las facturas que se leen en Contabilidad. Las que entran por planilla quedan en “pendiente”, y cotejar que las 18 líneas facturadas por un tercero sean 18 servicios que de verdad se hicieron sigue siendo trabajo de una persona.",
    verTambien: ["conciliacion_bancaria", "estado_pago", "estado_aprobacion", "conformidad"],
  },

  estado_admin: {
    clave: "estado_admin",
    termino: "Estado administrativo del servicio (Por liquidar → Liquidada → Facturada → Cobrada)",
    definicion:
      "Es el ciclo del servicio **del lado del cliente**: qué falta para que ese viaje se convierta en plata en la cuenta.\nSolo empieza cuando el servicio ya está finalizado, es decir cuando el bus salió y llegó. **Por liquidar** = falta cerrar el importe definitivo. **Liquidada** = la liquidación está aprobada. **Facturada** = se emitió el comprobante. **Cobrada** = entró el pago completo.",
    ejemplo:
      "El servicio del 12 de marzo termina y queda en Por liquidar. Se aprueba la liquidación del mes y pasa a Liquidada. Se emite F001-00025 por S/ 1,120 y pasa a Facturada. Entra el pago y pasa a Cobrada.",
    ojo:
      "Dos precisiones. No se avanza a dedo: se **deriva de hechos** — si hay factura emitida y el saldo es cero, es cobrada; si hay factura y queda saldo, es facturada. Y no lo confundas con el estado operativo del servicio (pendiente, programada, confirmada, en curso, finalizada o cancelada), que responde otra cosa: si el bus salió. Si además el servicio fue tercerizado, corre en paralelo un tercer ciclo del lado del proveedor.",
    verTambien: ["liquidacion_cliente", "conformidad", "factura", "cuentas_por_cobrar", "estado_proveedor"],
  },

  estado_proveedor: {
    clave: "estado_proveedor",
    termino: "Estado del proveedor (Por conciliar → Conciliada → Por pagar → Pagada)",
    definicion:
      "Es el ciclo del mismo servicio pero **del lado de quien lo ejecutó**, y solo existe cuando el servicio fue tercerizado.\n**Por conciliar** = el viaje se hizo, falta cuadrar cuánto cuesta. **Conciliada** = la liquidación al proveedor está aprobada. **Por pagar** = ya existe la cuenta por pagar. **Pagada** = se le transfirió y ese pago está aplicado.",
    ejemplo:
      "El servicio del 12 de marzo lo cubrió GRIJALVA TOURS. Del lado del cliente puede estar ya en Cobrada y del lado del proveedor seguir en Por pagar: cobraste S/ 1,120 y todavía le debes S/ 900 al tercero.",
    ojo:
      "Que un lado esté cerrado no cierra el otro. Mirar solo el ciclo del cliente hace creer que un servicio está terminado cuando en realidad todavía tiene una deuda colgando.",
    verTambien: ["estado_admin", "tercerizado", "liquidacion_proveedor", "cuentas_por_pagar"],
  },

  regla_oro: {
    clave: "regla_oro",
    termino: "Regla de oro (un monto, un solo sitio)",
    definicion:
      "Es la regla que ordena toda la parte de dinero del sistema: **cada monto se guarda en UN solo sitio y todo lo demás lo mira de ahí en vez de repetirlo.**\nPor eso el saldo de una factura no se guarda, se calcula; lo rendido en caja chica no se teclea, se suma de los comprobantes; y el costo de un servicio no se escribe, se junta de los egresos que llevan su número.",
    ejemplo:
      "Una rendición de S/ 500 con 14 comprobantes por S/ 437.50 y un vuelto de S/ 62.50: ni el 437.50 ni el 62.50 se escriben en ninguna casilla. Los dos salen de sumar los comprobantes cargados. Si alguien pudiera teclearlos a mano, tendrías dos verdades para el mismo dinero y no habría manera de saber cuál es la buena.",
    ojo:
      "Esta es la respuesta a “¿por qué Gastos y Finanzas me daban números distintos?”: antes cada pantalla sumaba por su cuenta y hoy las dos leen exactamente el mismo conjunto de egresos. Si algún día dos reportes te dan cifras diferentes, no elijas la que más te guste: revisa primero que los dos tengan los mismos filtros de fecha y de estado, y si aun así no cuadran, es señal de que algún monto se está registrando en dos sitios y hay que arreglarlo en el origen.",
    verTambien: ["saldo", "caja_chica", "margen_real", "comprobante", "fuga_bancaria"],
  },

  pacto_servicio: {
    clave: "pacto_servicio",
    termino: "Pacto del servicio",
    definicion:
      "Es **lo que se acordó cobrar y lo que se acordó pagar por un servicio**, con nombre, fecha y motivo. Cada servicio tiene dos: uno de venta con el cliente y uno de compra con el proveedor.\nCada vez que uno de esos importes cambia, el sistema levanta un acta sola —con folio, el antes y el después, quién lo hizo y por qué—. No la escribe nadie a mano: la escribe la base de datos.",
    ejemplo:
      "Pactaste RUTA 1 con GLOBAL BUS en S/ 500. A los tres días mandan a TRANSPORTES B y cobran S/ 550. Al guardar el cambio nace el acta PSC-2026-000118: “GLOBAL BUS → TRANSPORTES B, S/ 500 → S/ 550, el proveedor no tenía unidad, Rosa, 14-ago”. Nadie escribió esa frase: salió del gesto de cambiar el proveedor.",
    ojo:
      "El pacto NO frena la operación. El bus sale igual, el conductor recibe su aviso igual y el servicio se presta igual. Lo único que se puede frenar es el pago al proveedor si el sobrecosto quedó sin visto bueno. Confundir las dos cosas es lo que hace que las reglas se odien y se saboteen.",
    verTambien: ["adenda", "visado_gerencia", "costo_real_comparable", "regla_oro"],
  },

  afectacion_igv: {
    clave: "afectacion_igv",
    termino: "Afectación al IGV (gravado, exonerado, exportación)",
    definicion:
      "Es **cómo trata el IGV cada operación**, y no es igual para todas. En AFA conviven tres casos:\n• **Gravado** — lleva IGV 18 %. Es el transporte de personal, el grueso del negocio.\n• **Exonerado** — no lleva IGV. Es el servicio de taxi que AFA compra.\n• **Exportación** — no lleva IGV y además da derecho a recuperar el IGV de las compras. Es el paquete turístico vendido a un operador del exterior.",
    ejemplo:
      "Un mismo cierre de mes puede llevar una liquidación a una minera con 18 % de IGV y otra a una agencia extranjera a 0 %. Antes el sistema aplicaba una sola tasa a todo el periodo, así que ese cierre era imposible de emitir bien.",
    ojo:
      "De la afectación dependen tres cosas a la vez: si el comprobante lleva IGV, si hay detracción (**si no hay IGV, no hay detracción**) y cuánto te cuesta de verdad una compra. Por eso se declara por línea y no como una regla general de la casa.",
    verTambien: ["igv", "credito_fiscal", "detraccion", "costo_real_comparable"],
  },

  costo_real_comparable: {
    clave: "costo_real_comparable",
    termino: "Costo real (comparable entre proveedores)",
    definicion:
      "Es **lo que de verdad sale del bolsillo de AFA** por una compra, una vez descontado el IGV que se recupera.\nSi el proveedor da factura y la operación es gravada, el IGV vuelve como crédito fiscal y el costo real es el importe sin IGV. Si es exonerado, o si el proveedor entrega boleta o es del RUS, no hay nada que recuperar y el costo real es el importe completo.",
    ejemplo:
      "Un bus **gravado** que te factura S/ 550 te cuesta **S/ 466.10**. Un taxi **exonerado** que te cobra S/ 500 te cuesta **S/ 500.00**. El “caro” de 550 es en realidad 7 % más barato que el “barato” de 500.",
    ojo:
      "Nunca compares dos costos por lo que dice el importe. Al revés también engaña: un exonerado de S/ 550 contra un gravado de S/ 500 no es 10 % más caro, es **30 %**. El panel de margen de Programación ya hace esta cuenta sola; el número que muestra es el bueno.",
    verTambien: ["afectacion_igv", "credito_fiscal", "margen_real", "tercerizado"],
  },

  adenda: {
    clave: "adenda",
    termino: "Adenda del contrato",
    definicion:
      "Es **el resumen de todo lo que cambió en un contrato después de haberlo cotizado**: cuántos servicios se tocaron, cuánto subió o bajó la venta, cuánto el costo y cómo quedó el margen.\nNo se escribe: se arma sola juntando las actas de ese contrato.",
    ejemplo:
      "“Cotización #77 · +S/ 4 500 de venta · +S/ 1 800 de costo · 18 servicios · el cliente pidió otra unidad”. Eso es lo que se le imprime al cliente o a gerencia para sustentar por qué el mes salió distinto de lo cotizado.",
    ojo:
      "La adenda cuenta solo los cambios POSTERIORES a que el importe quedara pactado. Cargar por primera vez un costo que faltaba no es un cambio de contrato: es un dato que se estaba debiendo, y contarlo como adenda haría que un servicio regularizado pareciera una pérdida.",
    verTambien: ["pacto_servicio", "liquidacion_cliente", "conformidad"],
  },

  visado_gerencia: {
    clave: "visado_gerencia",
    termino: "Visado (visto bueno de gerencia)",
    definicion:
      "Es **la autorización de un cambio que empeora el margen** más allá de lo tolerado. Llega a la cola de gerencia con el antes, el después, el motivo y quién lo hizo, y se aprueba o se rechaza en bloque.",
    ejemplo:
      "Con la política en +10 % o +S/ 100 y margen mínimo 15 %, un cambio de S/ 500 a S/ 550 se auto-aprueba y no molesta a nadie. Uno de S/ 550 a S/ 950 sí llega a la cola.",
    ojo:
      "Un cambio que MEJORA el margen nunca pide visado, y es a propósito: si conseguir un proveedor más barato costara el mismo trámite que uno más caro, el operador aprende a esconder los dos. Y visar no deshace nada —el servicio ya se prestó—: autoriza la plata, no la operación.",
    verTambien: ["pacto_servicio", "estado_aprobacion", "margen_real"],
  },

  servicio_adicional: {
    clave: "servicio_adicional",
    termino: "Servicio adicional (fuera del contrato)",
    definicion:
      "Es **un servicio que el cliente pide por encima de lo contratado** y que se cobra aparte: una salida extra un viernes, una unidad más para una fecha puntual.\nSe registra con el botón **Adicional** de Reservas, al lado de “Programa fijo”. Se elige la misma cotización —de ahí salen los paraderos y la ruta—, se marcan las fechas sueltas, se elige si es ida, salida o las dos, y **se escribe el precio**, que puede ser distinto al del contrato.",
    ejemplo:
      "COMPAÑÍA HARD pide una salida extra el 12, el 14 y el 22 de agosto. La RUTA A está contratada a S/ 350, pero esas salidas necesitan una unidad mayor y se acuerdan en S/ 480. Se registran las tres fechas con precio S/ 480 y motivo “el cliente pidió una unidad de mayor capacidad”. En la liquidación de agosto salen en su propio renglón, con el rótulo ADICIONAL y sumadas en “Adicionales autorizados”, no mezcladas con los 22 servicios del contrato.",
    ojo:
      "Registrarlo como adicional no es un detalle de forma. Un adicional **nace** con su precio, así que no dispara el enlace de conformidad del cliente (ese salta cuando a un servicio ya creado se le SUBE el precio) — por eso el motivo se pide en el momento de crearlo: es el único sitio donde queda escrito por qué esa salida costó S/ 480. Y por eso el precio del adicional tampoco se propone después como referencia de la tarifa contractual.",
    verTambien: ["pacto_servicio", "liquidacion_cliente", "conformidad", "adenda"],
  },

  costo_empresa: {
    clave: "costo_empresa",
    termino: "Costo empresa de un conductor",
    definicion:
      "Es **lo que de verdad te cuesta un trabajador**, que no es su sueldo. Al básico hay que sumarle lo que la ley te obliga a pagar por él: EsSalud, SCTR (el transporte es actividad de riesgo), la parte proporcional de las gratificaciones y la de la CTS.\nY el costo de un DÍA no es eso entre 30: es el costo del mes dividido entre los días que esa persona **de verdad trabajó**.",
    ejemplo:
      "Un conductor de S/ 1,600 en pequeña empresa te cuesta **S/ 1,976 al mes** — 1.24 veces su sueldo. Si ese mes tuvo servicio 24 días, cada día cuesta **S/ 82.33**. Y si un día hizo dos vueltas, cada servicio carga S/ 41.17, no S/ 82.33.",
    ojo:
      "Tres errores que cuestan dinero. **Uno:** la AFP y la ONP NO son costo de la empresa, son descuento del trabajador — meterlas infla el costo un 13 %. **Dos:** el régimen cambia la cuenta; en MYPE pequeña empresa la gratificación es medio sueldo y la CTS son 15 remuneraciones diarias, así que el factor es 1.24 y no el 1.38 del régimen general. **Tres:** el sueldo es un costo del MES, no del servicio; imputarle el mes entero a cada viaje multiplica el costo por la cantidad de viajes y hace que todos parezcan pérdida.",
    verTambien: ["margen_real", "costo_real_comparable", "utilidad_servicio"],
  },

  utilidad_servicio: {
    clave: "utilidad_servicio",
    termino: "Utilidad de un servicio (antes de impuestos)",
    definicion:
      "Es **lo que deja un servicio** una vez descontado todo lo que costó: el ingreso sin IGV menos el costo real sin IGV.\nSe llama «antes de impuestos» porque todavía no se le descontó el Impuesto a la Renta. El IGV ya quedó fuera al usar los importes netos.",
    ejemplo:
      "Un servicio de S/ 365 con IGV son S/ 309.32 de ingreso. Si costó S/ 198.40 entre combustible, peajes, conductor y desgaste, la utilidad es **S/ 110.92**, o sea 35.9 %.",
    ojo:
      "El costo se publica en dos partes y no da lo mismo confundirlas. El **costo directo real** es lo que tiene comprobante atado al servicio. El **imputado** —conductor, depreciación, neumáticos— no tiene comprobante por viaje: se reparte, y sale del presupuesto. Un servicio sin presupuesto muestra el imputado en cero y **parece dejar más de lo que deja**; por eso la vista marca cuáles están así.",
    verTambien: ["costo_empresa", "margen_real", "presupuesto_servicio"],
  },

  presupuesto_servicio: {
    clave: "presupuesto_servicio",
    termino: "Presupuesto de un servicio",
    definicion:
      "Es **lo que planeaste gastar** en un servicio con unidad propia, renglón por renglón: combustible según el rendimiento medido de esa placa, peajes, viáticos, conductor y desgaste.\nSe guarda aparte del gasto real, y la diferencia entre los dos es lo que enseña.",
    ejemplo:
      "Presupuestaste S/ 42.85 de combustible con 24.5 km/gal y gastaste S/ 51.20. Ese +S/ 8.35 repetido mes tras mes en la misma ruta significa algo: o el rendimiento configurado está mal, o esa unidad necesita taller, o alguien está cargando de más.",
    ojo:
      "El presupuesto **nunca se escribe en el costo del proveedor**. Ese campo es lo que le debes a un tercero, y en flota propia no hay tercero: ponerlo ahí contaría los mismos soles dos veces y levantaría actas de compra contra un proveedor que no existe. Y el presupuesto **no es un asiento contable**: no hay obligación ni comprobante que registrar. Lo que va a Contabilidad es el gasto real.",
    verTambien: ["utilidad_servicio", "costo_empresa", "regla_oro"],
  },
};
