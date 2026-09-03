// ──────────────────────────────────────────────────────────────────────────────
// lib/ayuda/modulos-finanzas.ts — Fichas de ayuda del grupo DINERO.
//
// Escritas para el dueño del negocio, que NO es contador. La regla al redactar:
// se responde la pregunta que la persona hace de verdad ("¿por qué el banco me
// quita plata de la factura?"), con números de la operación real de AFA, y cuando
// algo lo tiene que decidir su contador se dice con esas palabras en vez de
// inventar una certeza.
//
// Los términos técnicos NO se definen aquí: se referencian por clave contra el
// glosario (lib/ayuda/glosario.ts), para que "detracción" diga lo mismo en
// Tesorería, en Facturación y en Contabilidad.
// ──────────────────────────────────────────────────────────────────────────────

import type { AyudaModulo } from "@/lib/ayuda/tipos";

export const MODULOS_FINANZAS: AyudaModulo[] = [
  // ══════════════════════════════════════════════════════════════════════════
  // TESORERÍA
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "tesoreria",
    rutas: ["/tesoreria"],
    titulo: "Tesorería · lo que AFA debe y cómo lo paga",
    resumen:
      "Es el tablero de todo el dinero que sale de la empresa: las facturas de los proveedores, los sueldos y gastos fijos, las detracciones que hay que depositar en el Banco de la Nación, los pagos que se mandan al banco en bloque, y el cruce final contra el extracto bancario. En el menú de la izquierda está como “Cuentas por Pagar”; dentro tiene cinco pestañas.",
    paraQueSirve: [
      "Saber cuánto le debes hoy a tus proveedores y cuánto de esa deuda ya está vencida.",
      "Que gerencia visé (apruebe) las facturas antes de que salga un sol del banco.",
      "Armar el archivo de pago masivo del BCP en vez de transferir una por una.",
      "No olvidarte de depositar las detracciones, que tienen plazo legal.",
      "Descubrir cargos en la cuenta que el ERP no sabe explicar.",
    ],
    conceptos: [
      "cuentas_por_pagar",
      "regla_oro",
      "saldo",
      "estado_aprobacion",
      "estado_pago",
      "adelanto",
      "detraccion",
      "spot",
      "banco_nacion",
      "aging",
      "vencimiento",
      "lote_pago",
      "telecredito",
      "cci",
      "nro_operacion",
      "conciliacion_bancaria",
      "extracto_bancario",
      "fuga_bancaria",
      "estado_conciliacion",
    ],
    faqs: [
      {
        pregunta: "¿Qué es una “cuenta por pagar”? Entro a Cuentas por pagar y lo que veo son facturas.",
        respuesta:
          "Y está bien, porque son lo mismo. Una **cuenta por pagar** no es un papel aparte: es simplemente **una factura de un proveedor que todavía no terminaste de pagar**.\n\nPor eso aquí no hay una lista de “deudas” separada de la lista de facturas. La factura ES la deuda. Cuando GRIJALVA TOURS te emite una factura por S/ 1,120, esa fila nace debiendo S/ 1,120; cada pago que registras le va bajando el saldo; cuando el saldo llega a cero, deja de ser una cuenta por pagar. Nadie “marca” la deuda a mano.\n\nEso es a propósito. Si el monto viviera en dos sitios (la factura por un lado y una “deuda” por otro), tarde o temprano dirían cosas distintas y no sabrías cuál creer. Aquí **el saldo se calcula solo, restando los pagos**, así que no puede desincronizarse.",
      },
      {
        pregunta: "¿Qué diferencia hay entre APROBADA y PAGADA? ¿Por qué son dos columnas distintas?",
        respuesta:
          "Son dos cosas que pasan en momentos distintos y por personas distintas:\n\n• **Aprobación** (columna “Aprobación”) = *gerencia dice que sí, este gasto es legítimo y hay que pagarlo*. Pasa por Pendiente → Aprobada → En lote, o Rechazada.\n• **Pago** (columna “Estado pago”) = *el dinero efectivamente salió del banco*. Va Impaga → Parcial → Pagada.\n\nSon **independientes a propósito**. Una factura puede estar **aprobada y sin pagar** (la visaste el lunes, el abono sale el viernes) o **pagada y sin aprobar** (una factura antigua que se importó del Sheet y nunca pasó por el visto de gerencia).\n\nSi fueran una sola columna tendrías que elegir entre mentir sobre lo que autorizaste o mentir sobre lo que pagaste. Por eso van separadas: la de arriba es control interno, la de abajo es plata de verdad.",
      },
      {
        pregunta: "Ya le pagué a ALVAREZ FARFAN. ¿Por qué la detracción sigue apareciendo como pendiente?",
        respuesta:
          "Porque **son dos pagos a dos destinatarios distintos**, y solo hiciste uno.\n\nEn una factura de S/ 1,120 con detracción del 10 %:\n• S/ 1,008 se le abonan **al proveedor**, a su cuenta del banco. Eso es lo que ya hiciste. → la factura queda *Pagada*.\n• S/ 112 los tienes que depositar tú **en la cuenta de detracciones del proveedor en el Banco de la Nación**. Eso es lo que falta. → la detracción sigue *Por depositar*.\n\nLa plata no es tuya: la retienes en nombre de la SUNAT y tienes plazo para depositarla. Por eso vive en su propia pestaña (**🏦 Detracciones**) y no como una columna más: pagarle al proveedor no te libera de ese depósito.\n\nVe a Detracciones, marca la factura, pulsa **Marcar depositada** y anota el número de constancia que devuelve el Banco de la Nación.",
      },
      {
        pregunta: "En la tabla veo Monto neto, Adelantos, Detracción, A cancelar y Saldo. ¿Cuál es cuál?",
        respuesta:
          "Con una factura de GRIJALVA TOURS por S/ 1,120, con un adelanto de S/ 300 y detracción del 10 %:\n\n• **Monto neto** = S/ 1,120. Es el **total del comprobante** tal como lo emitió el proveedor (con IGV incluido). El nombre despista, pero es el total impreso.\n• **Adelantos** = S/ 300. Lo que ya le habías entregado antes de la factura.\n• **Detracción** = S/ 112. Lo que no le abonas a él sino al Banco de la Nación.\n• **A cancelar** = S/ 708. Es 1,120 − 300 − 112: **lo que le transfieres al proveedor en este pago**. Este es el número que entra al lote del banco.\n• **Saldo** = el total del comprobante (S/ 1,120) menos los pagos que ya se le aplicaron. Ojo: el adelanto solo le baja el saldo si en su momento se registró como un pago. Cuando el saldo llega a cero la factura pasa a *Pagada*.\n\nNinguno de esos números se teclea: todos salen de restar. Tú solo cargas el total, los adelantos y la detracción.",
      },
      {
        pregunta: "¿Qué es un lote de pago y cómo se manda al banco?",
        respuesta:
          "Un **lote de pago** es un paquete de facturas ya aprobadas que se pagan de una sola vez, generando **un archivo que se sube al Telecrédito del BCP** en lugar de hacer 30 transferencias a mano.\n\nEl recorrido de un lote es: **Borrador → Aprobado → En Telecrédito → Pagado**.\n\n1. Armas el lote eligiendo las obligaciones aprobadas (agrupadas por beneficiario).\n2. Gerencia lo aprueba.\n3. Descargas el archivo y lo subes al Telecrédito.\n4. Cuando el banco ejecuta, vuelves y pulsas **Confirmar pago** con la fecha y el n.º de operación.\n\nRecién en ese paso 4 el ERP emite un pago por cada línea y baja el saldo de cada factura. Antes de eso, nada está pagado.\n\n**Una advertencia sobre ese archivo:** se genera como CSV con las columnas del pago masivo, pero el formato exacto lo define **el convenio de AFA con el BCP**. Ábrelo y cotéjalo una vez contra lo que pide tu Telecrédito antes de fiarte de él para una corrida completa.",
      },
      {
        pregunta: "¿Qué es conciliar el banco y qué es una “fuga”?",
        respuesta:
          "**Conciliar** es cruzar, movimiento por movimiento, el extracto que te da el banco contra lo que el ERP dice que pagaste o cobraste. La pregunta que responde es una sola: *¿hay algún cargo en mi cuenta que nadie sepa explicar?*\n\nUn cargo así es una **fuga**: salió plata y el ERP no tiene ninguna factura, gasto ni lote que lo justifique. Sale en el bloque rojo grande de arriba (“Regla Cero Fugas”) con el monto total.\n\nUna fuga puede ser tres cosas: (1) un pago real que nadie registró, (2) una comisión o un ITF del banco —eso se marca como *Ignorado*—, o (3) algo que hay que investigar en serio.\n\n**Ojo con el casado automático:** solo se concilian solos los movimientos con el **mismo número de operación**. Los que coinciden solo en importe y fecha se te *proponen* y los confirmas tú, porque en transporte dos servicios del mismo precio el mismo día es lo normal, no la excepción.",
      },
      {
        pregunta: "Al armar el lote hay líneas en amarillo que no me deja marcar. ¿Por qué?",
        respuesta:
          "Porque **esa línea no tiene número de cuenta ni CCI**, y sin eso el banco no puede abonarle nada. Aparece en amarillo con el aviso “Sin cuenta ni CCI del beneficiario — no se puede abonar sin cuenta ni CCI” y la casilla queda muerta.\n\n**Dónde se arregla hoy: en la propia factura, no en la ficha del proveedor.** Ve a 🧾 Cuentas por pagar, busca ese comprobante, pulsa **Editar** y llena arriba los campos **Titular de la cuenta**, **Banco**, **Número de cuenta** y **CCI**. Guarda, vuelve al armado del lote y pulsa **Actualizar lista**: ya te dejará marcarla.\n\n(La pantalla de Proveedores todavía no tiene esos campos. Si un proveedor ya los trae cargados en su ficha, el modal de la factura los rellena solo al elegirlo; si no, se escriben ahí a mano.)\n\nSi el amarillo trae otro aviso —por ejemplo “Sin RUC del proveedor”— sí puedes incluirla: eso es una advertencia, no un bloqueo.",
      },
      {
        pregunta: "El banco me devolvió una transferencia del lote. ¿Cómo lo registro?",
        respuesta:
          "Al pulsar **Confirmar pago** el modal te lista todas las líneas del lote con un campo de texto debajo de cada una.\n\n• Si el banco **sí pagó** esa línea: deja el campo vacío.\n• Si el banco **la devolvió**: escribe el motivo (por ejemplo “cuenta cerrada”).\n\nSolo las líneas con motivo escrito se marcan como rechazadas y **no generan pago**: esas facturas siguen debiéndose y vuelven a aparecer como pendientes para el siguiente lote. Las demás sí bajan su saldo.",
      },
      {
        pregunta: "¿Para qué sirve la pestaña Planilla y admin. si ya tengo Cuentas por pagar?",
        respuesta:
          "**Cuentas por pagar** es el gasto que llega con una factura de proveedor detrás (GRIJALVA TOURS, el taller, el grifo).\n\n**Planilla y admin.** es el gasto que **no tiene factura**: sueldos, honorarios de gerencia, el alquiler de la cochera, la luz, los tributos. Necesitas registrarlo igual porque también sale del banco y también entra al lote de pago.\n\nSe maneja con los mismos dos semáforos (aprobación y pago) que las facturas, así que **un mismo lote de pago puede mezclar una factura de proveedor con la planilla del mes**.\n\nEl botón **🔁 Generar mes siguiente** copia al mes que viene los gastos que marcaste como recurrentes y que estén aprobados en el mes que tienes filtrado. Los copia **como pendientes**: un alquiler que subió de precio o un sueldo que cambió tiene que pasar por el ojo de alguien antes de convertirse en obligación.",
      },
      {
        pregunta: "Mi contador me pide el “código de detracción”. ¿Cuál pongo?",
        respuesta:
          "Los dos que tocan a AFA se confunden todo el tiempo, así que atención:\n\n• **026 — transporte de PERSONAS, 10 %**, umbral S/ 700 (Anexo 3). Este es el de AFA: transporte de personal.\n• **027 — transporte de CARGA, 4 %**, umbral S/ 400 y una regla extra: se calcula sobre el importe de la operación **o sobre el valor referencial, el que sea mayor**.\n\nLa tasa y el código no están clavados en el programa: viven en una tabla editable (pestaña **🏦 Detracciones** → franja **“⚙️ Tasas y códigos de detracción”**), porque **el SPOT cambia por Resolución de Superintendencia**. La verdad es la fila de esa tabla, no lo que diga ningún manual.\n\n**Esto lo confirma tu contador, no el ERP.** El código correcto depende del servicio exacto que estés comprando o vendiendo, y una tasa mal puesta se paga con multa.",
      },
      {
        pregunta: "¿Qué significan Vigente, 1-30 d, 31-60 d, +90 d en la columna Vencimiento?",
        respuesta:
          "Es la **antigüedad de la deuda**: cuántos días llevas pasado de la fecha de vencimiento que pactaste con ese proveedor.\n\n• **Vigente** (verde): todavía no vence, todo bien.\n• **1-30 d** (amarillo): se te pasó, pero es reciente.\n• **31-60 d / 61-90 d / +90 d** (naranja y rojo): deuda vieja. Es la que te va a costar la relación con el proveedor.\n\nEl KPI de arriba **“Vencidas +30 días”** te suma en soles todo lo que ya está en zona roja. Si ese número crece mes a mes, tienes un problema de caja, no de papeleo.",
      },
      {
        pregunta: "El KPI dice “Detracciones por pagar: S/ 4,300”. ¿Es plata que sale ADEMÁS de lo que le pago a los proveedores?",
        respuesta:
          "No, es **la misma plata, con otro destinatario**. Ya está descontada de lo que le abonas al proveedor.\n\nEn una factura de S/ 1,120 salen S/ 1,120 de tu bolsillo pase lo que pase: S/ 1,008 a la cuenta del proveedor y S/ 112 al Banco de la Nación. El KPI te avisa de cuánto de eso todavía no depositaste.\n\nLo que sí es cierto es que si nunca la depositas, esa plata **sigue en tu cuenta y no es tuya** — y llega el momento en que la SUNAT la reclama con intereses.",
      },
      {
        pregunta: "En la pestaña Detracciones hay una segunda tabla que dice “ventas”. ¿Qué es eso?",
        respuesta:
          "Es el **lado espejo**: las detracciones que **te retuvieron a ti** tus clientes al pagarte tus propias facturas.\n\nEsa plata está depositada en la cuenta de detracciones de AFA en el Banco de la Nación y solo sirve para pagar impuestos. La tabla lista las facturas emitidas de las que todavía no tienes la constancia del depósito: son las que hay que **reclamarle al cliente**, porque sin constancia no sabes si de verdad depositó.",
      },
      {
        pregunta: "Anulé un lote por error. ¿Se perdieron las facturas?",
        respuesta:
          "No. Al anular un lote **las facturas vuelven a estar aprobadas** y disponibles para armar otro lote. No se borra nada y no se deshace ningún pago que ya se hubiera confirmado.\n\nSolo se pueden anular lotes que todavía no están pagados.",
      },
    ],
    comoHacer: [
      {
        titulo: "Registrar a mano la factura de un proveedor",
        pasos: [
          "Entra a Tesorería → pestaña 🧾 Cuentas por pagar y pulsa “+ Registrar factura”.",
          "Escribe el proveedor: si ya está en el padrón, elígelo de la lista y el RUC, el titular, el banco, la cuenta y el CCI se rellenan solos con lo que tenga guardado. Si no está, escribe la razón social tal cual figura impresa en la factura.",
          "Si vas a pagarle por el archivo del banco, comprueba que Titular de la cuenta, Banco, Número de cuenta y CCI estén llenos: sin cuenta ni CCI, esta factura no podrá entrar a un lote de pago.",
          "Completa Tipo (Factura / Boleta / Recibo por honorarios…), Serie (F001) y Número (0001234), y la fecha de emisión.",
          "En “Importe del comprobante” pon el número que ves impreso y elige en “Cómo se ingresa” si ese número es el Total (IGV incluido) o el Neto (sin IGV). El recuadro gris de abajo te muestra el desglose: Subtotal, IGV, Total y A cancelar.",
          "Elige el Código de detracción. Si el comprobante trae impreso otro porcentaje o monto, sobrescríbelo en los campos “Detracción %” y “Detracción monto”.",
          "Si le habías dado plata por adelantado, ponla en Adelanto 1 / Adelanto 2: se descuenta de lo que le vas a abonar.",
          "Llena el bloque “Servicio asociado” (código de servicio, placa como CWQ-400, fecha y turno). No es obligatorio, pero es lo que permite después saber cuánto costó de verdad ese servicio.",
          "Pulsa “Registrar factura”. Nace Pendiente de aprobación e Impaga.",
        ],
        advertencia:
          "Si el ERP te dice “Ese comprobante ya está registrado para el mismo RUC”, es que esa serie y número ya existen: alguien la cargó antes o vino en una importación. Búscala con el buscador en vez de crear un duplicado.",
      },
      {
        titulo: "Aprobar varias facturas de golpe y armar el lote de pago",
        pasos: [
          "En 🧾 Cuentas por pagar, filtra por “Toda aprobación → Pendiente” para ver solo lo que falta visar.",
          "Marca las casillas de las facturas que apruebas (o la casilla de la cabecera para marcarlas todas). Abajo aparece una barra con cuántas van y por cuánto.",
          "Pulsa “Aprobar seleccionadas”. Si alguna está mal, en vez de aprobarla pulsa “Rechazar” y escribe el motivo: queda grabado en el comprobante y lo ve quien la registró.",
          "Ve a la pestaña 📦 Lotes de pago y pulsa “+ Nuevo lote”.",
          "Arriba pon el filtro “Vencimientos hasta” (por ejemplo fin de mes), decide si incluyes las detracciones al Banco de la Nación, elige la cuenta de cargo y la fecha programada de abono.",
          "Abajo salen las obligaciones aprobadas agrupadas por beneficiario. Marca las que entran; puedes marcar un beneficiario entero de una vez.",
          "Pulsa “Crear lote”. Nace en Borrador.",
          "Abre el lote (fila → “▼ Ver líneas”) y pulsa “Aprobar lote”. Luego “⬇️ Descargar archivo Telecrédito” y súbelo al banco.",
          "Cuando lo subas, vuelve y pulsa “Marcar enviado al banco”.",
          "Cuando el banco ejecute, pulsa “Confirmar pago”, pon la fecha y el n.º de operación, y deja vacío el motivo de las líneas que sí se pagaron.",
        ],
        advertencia:
          "Solo gerencia (rol admin o gerente) puede aprobar. Si no tienes ese rol verás el candado “Solo gerencia puede aprobar pagos”: puedes armar el lote, pero no visarlo. Y recuerda cotejar una vez el archivo CSV contra el formato que pide tu convenio con el BCP.",
      },
      {
        titulo: "Subir un Google Sheet histórico de cuentas por pagar",
        pasos: [
          "En la hoja de Google, compártela como “Cualquiera con el enlace · Lector”. Sin eso el ERP no puede leerla (no usa tus credenciales de Google).",
          "En 🧾 Cuentas por pagar pulsa “⬆️ Importar”.",
          "Paso 1 · Origen: arrastra el Excel, o pega el enlace de la hoja y pulsa “Leer hoja”. Si no sabes qué columnas poner, pulsa antes “⬇️ Descargar plantilla”.",
          "Paso 2 · Revisión: el ERP reconoce solo el formato (OSLO con código de servicio y turno, o el tradicional) y te dice con qué porcentaje de coincidencia. REVISA AQUÍ: arriba salen “Filas válidas”, “Con error” y “Total leídas”, y abajo una vista previa de lo que va a entrar.",
          "Si el formato no calzó bien, cámbialo en el desplegable o corrige a mano el “🔗 Mapeo de columnas”: para cada campo eliges de qué columna de tu hoja sale.",
          "Si hay filas con error, pulsa “⬇️ Descargar filas rechazadas”: te bajas un archivo con esas filas y el motivo de cada una, para corregirlas en el Sheet y volver a subirlas.",
          "Cuando el número de filas válidas te cuadre, pulsa “Importar N fila(s)”. Paso 3 · Resultado: cuatro cifras — Creadas, Omitidas (ya existían), Con error y Leídas.",
        ],
        advertencia:
          "El importador nunca convierte en cero un monto que no entiende: si no puede leerlo, rechaza la fila y te la devuelve con el motivo. Revisa siempre el paso 2 antes de continuar; una vez subidas, deshacer una importación es tarea aparte.",
      },
      {
        titulo: "Marcar una detracción como depositada",
        pasos: [
          "Deposita primero de verdad en el Banco de la Nación, en la cuenta de detracciones del proveedor. El ERP no deposita nada: solo lleva el control.",
          "Entra a Tesorería → pestaña 🏦 Detracciones. En la tabla “Compras · por depositar en el Banco de la Nación” están las que debes.",
          "Marca la casilla de la factura, o de varias si las depositaste juntas, y pulsa “Marcar depositadas”. Para una sola también sirve el botón “Marcar depositada” de su fila.",
          "Escribe el N° de constancia que devolvió el Banco de la Nación y la fecha real del depósito.",
          "Pulsa “Confirmar depósito”. La factura pasa de “Por depositar” a “Depositada” y desaparece de la bandeja.",
        ],
        advertencia:
          "Si marcas varias a la vez, la MISMA constancia y fecha se aplican a todas. Hazlo solo si de verdad fueron un único depósito; si no, quedas sin poder probar cuál constancia corresponde a cuál factura.",
      },
      {
        titulo: "Conciliar el extracto del banco",
        pasos: [
          "Descarga desde el Telecrédito el movimiento de la cuenta en Excel, del periodo que quieras revisar.",
          "Entra a Tesorería → pestaña 🔗 Conciliación y elige arriba la cuenta de tesorería y el rango de fechas.",
          "Pulsa “⬆️ Importar extracto” y sube el archivo. Volver a subir un rango que ya cargaste NO duplica filas: las repetidas se detectan solas.",
          "Pulsa “🔗 Conciliar automáticamente”. Se casan solos los movimientos que coinciden por número de operación; el resto queda propuesto u observado.",
          "Mira el bloque rojo “Regla Cero Fugas”: es la plata que salió y el ERP no sabe justificar. Trabaja esa lista.",
          "Para cada fuga, pulsa “Conciliar…”. Si el ERP te propone candidatos, revisa el porcentaje de confianza y pulsa “Es este” en el correcto.",
          "Si es una comisión del banco o un ITF, pulsa “Marcar como ignorado (comisión / ITF)”. Si no sabes qué es, pulsa “Marcar observado” y déjalo para investigar.",
          "Cuando termines, exporta lo que quede sin justificar con “⬇️ Exportar fugas” y revísalo con tu contador.",
        ],
        advertencia:
          "No confirmes a ciegas una propuesta que coincide solo en importe y fecha. En transporte dos servicios de S/ 960 el mismo día son lo normal, y casar el movimiento con la factura equivocada deja las dos mal.",
      },
      {
        titulo: "Corregir la tasa o el código de detracción cuando cambia la norma",
        pasos: [
          "Entra a Tesorería → pestaña 🏦 Detracciones. Bajo los cuatro recuadros de arriba hay una franja que dice “⚙️ Tasas y códigos de detracción”: pulsa “▼ Configurar” para abrirla.",
          "Busca el código en la lista (026, 027…), edita el porcentaje o el umbral y pulsa guardar en esa fila.",
          "El cambio aplica a los comprobantes NUEVOS que registres desde ese momento; no reescribe las facturas ya cargadas.",
        ],
        advertencia:
          "Solo admin o gerente pueden editar estas tasas, y esto se hace únicamente cuando tu contador te confirma que salió una Resolución de Superintendencia que las cambió. Cambiar una tasa por intuición desalinea todo lo que emitas después.",
      },
    ],
    relacionadas: [
      { etiqueta: "Caja chica · plata en efectivo", href: "/caja-chica" },
      { etiqueta: "Gastos · costo real por servicio", href: "/gastos" },
      { etiqueta: "Proveedores · datos bancarios", href: "/proveedores" },
      { etiqueta: "Liquidaciones · de dónde nacen las facturas de proveedor", href: "/liquidaciones" },
      { etiqueta: "Contabilidad · el lado fiscal", href: "/contabilidad" },
      { etiqueta: "Finanzas · resumen de ingresos y egresos", href: "/finanzas" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CAJA CHICA
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "caja-chica",
    rutas: ["/caja-chica"],
    titulo: "Caja chica · el efectivo que anda fuera de la caja",
    resumen:
      "Aquí se controla la plata en efectivo que le entregas a cualquiera de tu gente —un chofer, el gerente, contabilidad, administración— para peajes, útiles, courier, trámites y emergencias: cuánto le diste, en qué la gastó, qué comprobantes trajo y cuánto devolvió.",
    paraQueSirve: [
      "Saber en todo momento cuánto dinero de la empresa está fuera de la caja, y en manos de quién.",
      "Impedir que se le siga entregando plata a alguien que no ha rendido la anterior.",
      "Revisar comprobante por comprobante, con la foto que el chofer sacó desde su app o la que se cargó desde el ERP.",
      "Que esos gastos lleguen solos al costo del vehículo, del servicio o del área, sin volver a tipearlos.",
      "Ver cuánto gasta cada área (Gerencia, Contabilidad, Operaciones) en efectivo, mes a mes.",
    ],
    conceptos: [
      "caja_chica",
      "entrega_a_rendir",
      "rendicion",
      "reposicion",
      "saldo",
      "comprobante",
      "estado_aprobacion",
      "centro_costo",
      "costo_directo",
    ],
    faqs: [
      {
        pregunta: "¿Qué es una “rendición”, en cristiano?",
        respuesta:
          "Es **el ciclo completo de una entrega de plata**: le das S/ 300 al chofer de la CWQ-400, él gasta durante unos días, sube las fotos de los tickets y al final te devuelve lo que sobró.\n\nEsa rendición se abre cuando entregas el dinero y se cierra cuando tú apruebas los comprobantes y cuadras el saldo. Todo lo que pase en medio (cada peaje, cada lavado) es un comprobante dentro de esa rendición.\n\nLos estados son:\n• **Abierta** — le diste la plata, está gastando.\n• **Por revisar** — él la cerró y te la mandó.\n• **Observada** — se la devolviste con reparos.\n• **Liquidada** — la aprobaste y cuadró. Fin del ciclo.\n• **Anulada** — se dejó sin efecto.",
      },
      {
        pregunta: "¿La caja chica es solo para los choferes?",
        respuesta:
          "**No.** La recibe cualquiera que maneje efectivo de la empresa: el gerente, el contador, el asistente administrativo, la recepcionista, un practicante. La primera versión del módulo se pensó mirando la calle y por eso pedía elegir un conductor; ya no.\n\nAl crear un fondo (pestaña 💰 Fondos → “+ Nuevo fondo”) lo primero que eliges es **quién lo recibe**, entre cuatro opciones:\n\n• **🧑‍✈️ Conductor** — sale de tu lista de choferes.\n• **🧑‍💼 Personal administrativo** — sale de tu lista de Personal administrativo, con su cargo y su departamento.\n• **👤 Usuario del ERP** — alguien con cuenta en el sistema que no está en esa planilla.\n• **📌 Otro** — practicante o personal temporal, sin ficha propia: el nombre se escribe a mano.\n\nSegún lo que elijas cambia la lista de personas que te ofrece, el plazo sugerido para rendir (7 días para la calle, 15 para oficina) y qué categorías de gasto te propone primero.",
      },
      {
        pregunta: "Soy de oficina y no tengo la app del conductor. ¿Cómo rindo mis gastos?",
        respuesta:
          "Desde el ERP, con el botón **“+ Comprobante”**.\n\nEntra a Caja chica → pestaña 🧾 Rendiciones, busca tu rendición (la que está **Abierta** u **Observada**) y pulsa “+ Comprobante” en su fila. Se abre un formulario donde pones la categoría, la fecha, el monto, el número de comprobante y **adjuntas la foto o el PDF** de la boleta.\n\nEs exactamente el mismo comprobante que sube un chofer desde su celular: entra a la misma rendición, con el mismo estado *Pendiente*, y lo revisa la misma persona.\n\nEl botón solo aparece en rendiciones vivas. Si la tuya ya está *Por revisar* o *Liquidada* no se le pueden agregar gastos por detrás — pide que te la devuelvan **Observada** y ahí sí puedes completarla.",
      },
      {
        pregunta: "Mis gastos son de oficina (útiles, courier, notaría). ¿Qué categoría les pongo?",
        respuesta:
          "El selector de categorías trae las de oficina además de las de calle, y te muestra primero las que van con el tipo de responsable del fondo:\n\n• **🖇️ Útiles de oficina** — papel, tóner, archivadores.\n• **📦 Courier / envíos** — mensajería, envío de documentos a provincia.\n• **☕ Refrigerio** — café, agua, refrigerio de una reunión interna.\n• **🤝 Representación** — almuerzo o atención a un cliente.\n• **💡 Servicios básicos**, **🧴 Limpieza**, **🛠️ Mantenimiento del local**, **🎓 Capacitación**.\n\nY las comunes a todos: **🚕 Movilidad** (un taxi a SUNAT) y **📄 Trámite** (notaría, SUNARP, municipalidad).\n\n**Ojo con Representación:** tiene tope tributario. Solo es deducible hasta el 0.5 % de tus ingresos brutos acumulados, con un máximo de 40 UIT (art. 37 inc. q de la Ley del Impuesto a la Renta), y exige comprobante con el RUC de AFA. Por eso está separada de Refrigerio: para que tu contador pueda sumarla aparte.",
      },
      {
        pregunta: "¿Los gastos de oficina se mezclan con el costo de los vehículos?",
        respuesta:
          "No. Cuando apruebas la rendición y los comprobantes suben al libro de Gastos, cada uno viaja con su **plano contable**: lo de calle entra como **operativo** y lo de oficina como **administrativo**.\n\nEso importa porque el costo por vehículo y el margen por servicio se calculan sobre lo operativo. Si el tóner de gerencia entrara como operativo, te ensuciaría el margen de una unidad que no tuvo nada que ver.\n\nY si además quieres que un gasto sí se le impute a un servicio concreto, elígelo en el campo **“Servicio (opcional)”** al registrar el comprobante: recién ahí aparece en su costo real.",
      },
      {
        pregunta: "¿Cómo sé cuánto gasta cada área en efectivo?",
        respuesta:
          "En la pestaña 💰 Fondos, arriba de la tabla, tienes unas pastillas con **cuánto hay en la calle por área** (Gerencia, Contabilidad, Operaciones…). Y la tabla trae su propia columna **Área**.\n\nEl área **no se teclea dos veces**: para el personal administrativo sale de su ficha en *Personal administrativo* (su departamento), y para los choferes es “Operaciones”. Si alguien cambia de departamento allí, los reportes de caja chica lo siguen solos.\n\nPara quien no tiene ficha (tipo *Otro*), el campo “Centro de costo / área” del fondo es el que manda.",
      },
      {
        pregunta: "Registré un comprobante con el monto equivocado. ¿Lo puedo borrar?",
        respuesta:
          "Sí, **mientras nadie lo haya revisado todavía**. Despliega la rendición con la flecha de su fila: cada comprobante en estado *Pendiente* tiene un botón **Borrar** que lo elimina junto con su foto.\n\nSi ya está *Aprobado* o *Rechazado*, no se borra: la corrección es **rechazarlo** escribiendo el motivo, que deja rastro de qué pasó. Y si ya se promovió al libro de Gastos, se corrige desde /gastos.",
      },
      {
        pregunta: "No me deja entregarle más plata a un chofer. ¿Por qué?",
        respuesta:
          "Porque **tiene una rendición sin cerrar**. Es la regla central del módulo: no se entrega dinero a quien no ha rendido.\n\nAl elegir el fondo en el modal “Entregar dinero”, el ERP consulta y te muestra un cartel verde (✅ Habilitado) o rojo (⛔ Bloqueado) con el motivo exacto. Los motivos que puede darte son:\n\n• **“Ya tiene una rendición abierta sin liquidar (S/ X). Ciérrala antes de entregar más dinero.”** — primero cierra esa.\n• **“Tiene N rendición(es) vencida(s) sin liquidar por S/ X.”** — se le pasó el plazo de días para rendir del fondo.\n• **“Alcanzó su tope de S/ X.”** — el fondo tiene un límite de dinero en la calle y ya está en él.\n• **“El fondo está inactivo.”** — alguien lo desactivó; se reactiva en la pestaña 💰 Fondos.\n\nMientras diga Bloqueado, los campos de monto y fecha quedan grises y el botón Entregar no funciona. No es un capricho de la pantalla: la regla vive en la base de datos, así que tampoco se puede saltar por otro camino.\n\n**Para desbloquear:** ve a la rendición vieja, revísala y liquídala. Si de verdad hay una urgencia, la salida limpia es cerrar la rendición pendiente con lo que haya, no forzar el sistema.",
      },
      {
        pregunta: "Se perdió el comprobante de un gasto. ¿Qué hago?",
        respuesta:
          "El gasto igual se registra. Si no se adjunta foto —desde la app del conductor o marcando “No hubo comprobante” en el ERP— el gasto entra señalado como **“sin comprobante”** y llega a tu bandeja como cualquier otro, con su categoría y su monto.\n\nAhí tú decides, y las dos decisiones tienen consecuencias distintas:\n\n• **Lo apruebas** → cuenta como rendido. El chofer no tiene que devolver ese dinero. Es tu decisión de gerencia: aceptas el gasto aunque no tengas papel. Sin comprobante **no da derecho a crédito fiscal**, así que es plata que sale y no te descuenta impuestos — coméntalo con tu contador si se vuelve costumbre.\n• **Lo rechazas** (escribiendo el motivo) → NO cuenta como rendido. El monto se le queda debiendo: al cerrar la rendición, el chofer tiene que devolver esa plata en efectivo para que cuadre.\n\nEsa es exactamente la palanca que te da el módulo: “sin ticket, lo pagas tú” es una decisión, no un accidente.",
      },
      {
        pregunta: "¿Qué es el número grande azul que dice “Dinero en la calle”?",
        respuesta:
          "Es **la suma de todo el efectivo de la empresa que ahora mismo está fuera de tu caja**, en manos de tus responsables, sin rendir. Es la banda azul oscuro que corona el módulo.\n\nDebajo te dice entre cuántas personas está repartido, cuántas rendiciones siguen abiertas y cuántas están atrasadas.\n\nEs el semáforo del módulo: si ese número crece y crece, no es que gastes más, es que **nadie está rindiendo**.",
      },
      {
        pregunta: "Me dice “La rendición no cuadra: faltan S/ 45.00 por rendir o devolver”. ¿Qué significa?",
        respuesta:
          "La cuenta que tiene que dar cero es siempre la misma:\n\n**Lo que le entregaste − lo que rindió en comprobantes − lo que devolvió en efectivo = 0**\n\nArriba del modal tienes las tres piezas (Asignado, Rendido, Devuelto) y un cuarto recuadro que dice **Cuadra**, **Falta rendir** o **Excedido** con el monto; abajo, junto a los botones, sale ese mismo aviso en palabras. Si le diste S/ 300, tiene comprobantes por S/ 255 y anotaste S/ 0 devuelto, faltan S/ 45. Solo hay tres explicaciones y las tres tienen arreglo:\n\n1. **Sí te devolvió efectivo y no lo anotaste** → escríbelo en el campo “Efectivo devuelto”. El recuadro se recalcula mientras tecleas.\n2. **Le falta subir un comprobante** → pulsa “Observar”, escribe el motivo y la rendición vuelve al responsable para que lo complete.\n3. **Se gastó esos S/ 45 y no lo puede justificar** → esa es la conversación que hay que tener. Si decides que lo asume él, ese monto se le queda debiendo.\n\nSi dice **Excedido** es al revés: gastó más de lo que le diste y la empresa le debe la diferencia.",
      },
      {
        pregunta: "Al aprobar aparece marcada la casilla “Promover gastos aprobados al módulo Gastos”. ¿Qué hace y la dejo marcada?",
        respuesta:
          "Déjala marcada. Lo que hace es **pasar cada comprobante aprobado al libro general de gastos**, para que ese peaje de S/ 18 aparezca junto al combustible y el mantenimiento cuando mires el costo de la CWQ-400 o el margen de un servicio.\n\nY no, no se cuenta dos veces: en cuanto un comprobante se promueve, **deja de contarse por el lado de caja chica**. El mismo sol aparece en un solo sitio.\n\nSi la desmarcas, el gasto queda registrado y controlado en caja chica pero no sube al libro general — solo tiene sentido si tu contador te pide tratarlo aparte.",
      },
      {
        pregunta: "¿Qué diferencia hay entre “Observar” la rendición y “Rechazar” un comprobante?",
        respuesta:
          "• **Rechazar un comprobante** es puntual: ese ticket no vale (está ilegible, es de otra fecha, no corresponde a la empresa). Escribes el motivo y ese monto deja de contar como rendido. El resto de la rendición sigue su curso.\n\n• **Observar la rendición** es devolver el paquete entero al responsable: “esto no lo puedo cerrar todavía, arréglalo”. Le llega tu motivo y la rendición pasa a estado *Observada* hasta que la vuelva a mandar.\n\nUsa Rechazar para un ticket suelto y Observar cuando el problema es de la rendición completa (le faltan comprobantes, no cuadra, están todos borrosos).",
      },
      {
        pregunta: "¿No puedo aprobar la rendición? Dice que faltan comprobantes por revisar.",
        respuesta:
          "Correcto, y es a propósito: **no se puede cerrar una rendición mientras quede un solo comprobante en estado Pendiente**. El módulo existe justamente para que nadie apruebe en bloque sin mirar.\n\nEn el modal, cada comprobante tiene sus botones Aprobar / Rechazar. En la cabecera te dice “Comprobantes (7) · 2 sin revisar”. Decide esos dos y el botón “Aprobar y liquidar” funcionará.",
      },
      {
        pregunta: "¿Para qué sirven el “Tope” y los “Días para rendir” de un fondo?",
        respuesta:
          "Son las dos reglas que le pones a cada persona cuando creas su fondo, en la pestaña 💰 Fondos:\n\n• **Tope en la calle** — cuánto máximo puede tener sin rendir. Si le pones S/ 500, cuando llegue a ese monto queda bloqueado hasta rendir. Pon 0 si no quieres tope.\n• **Días para rendir** — el plazo, contado desde la fecha de entrega. Pasado ese plazo la rendición cuenta como **atrasada** (sale en el KPI “Atrasadas” y en el filtro “Solo atrasadas”) y la persona queda bloqueada automáticamente.\n\nUn chofer que sale a provincia necesita más tope y más días que uno de ruta urbana; por eso se configura por persona y no global.",
      },
      {
        pregunta: "Al entregar dinero hay una casilla “Registrar salida de tesorería”. ¿La marco?",
        respuesta:
          "Márcala si el dinero **sale ahora de una cuenta que llevas en el ERP**. Lo que hace es emitir el pago en efectivo contra la **cuenta de tesorería que tenga configurada ese fondo**, para que el saldo de esa cuenta baje de verdad. (Si el fondo no tiene cuenta asignada, asígnasela primero en la pestaña 💰 Fondos.)\n\nDéjala sin marcar si estás repartiendo efectivo que ya habías sacado antes y que el ERP ya contó como salida. Si la marcas dos veces por la misma plata, la cuenta te va a quedar más baja de lo que está en realidad.",
      },
      {
        pregunta: "Abro la foto del comprobante y al rato el enlace deja de funcionar. ¿Por qué?",
        respuesta:
          "Porque las fotos de comprobantes se guardan en un **almacén privado**, no público: un ticket de peaje trae la placa y la ubicación del vehículo, y eso no puede quedar con un enlace abierto en internet.\n\nCada vez que abres la rendición, el ERP genera un enlace temporal (dura una hora). Si se te venció, cierra y vuelve a abrir la rendición y la foto carga de nuevo.",
      },
    ],
    comoHacer: [
      {
        titulo: "Entregar dinero a un responsable",
        pasos: [
          "Entra a Caja chica → pestaña 🧾 Rendiciones y pulsa “+ Entregar dinero”.",
          "Elige el fondo/responsable. Espera el cartel: verde “Habilitado” o rojo “Bloqueado”. Si sale rojo, lee el motivo — casi siempre es una rendición anterior sin cerrar.",
          "Pon el “Monto a entregar” y la “Fecha de entrega”. Si es plata para un vehículo concreto, elige la placa en “Vehículo (opcional)” (por ejemplo CWQ-400): así el gasto se le imputa a esa unidad.",
          "“Periodo hasta (opcional)” es solo una anotación de hasta qué día cubre esa entrega. NO es el plazo para rendir: ese lo fija el fondo con sus “Días para rendir”, contados desde la fecha de entrega, y es el que después marca la rendición como atrasada.",
          "Marca “Registrar salida de tesorería” solo si el efectivo sale ahora de una cuenta que llevas en el ERP.",
          "Pulsa “Entregar”. Se abre la rendición y el monto entra al “Dinero en la calle”.",
        ],
        advertencia:
          "Si el cartel sale rojo, no busques la vuelta: la regla también está en la base de datos y no se puede saltar por otra pantalla. Cierra primero la rendición pendiente.",
      },
      {
        titulo: "Revisar y liquidar una rendición",
        pasos: [
          "Entra a Caja chica → pestaña 🔍 Por revisar. Están ordenadas por antigüedad, con los días que llevan esperando (rojo a partir de 3 días).",
          "Abre una con “Revisar”. Arriba ves cuatro recuadros: Asignado, Rendido, Devuelto y el veredicto (Cuadra / Falta rendir / Excedido) con su monto.",
          "Baja por los comprobantes. En cada uno mira la foto (“Ver en grande” la abre completa), la categoría, el monto y la descripción.",
          "Pulsa Aprobar en los que están bien. En los que no, pulsa Rechazar y escribe el motivo — sin motivo no deja rechazar.",
          "Cuando no quede ninguno pendiente, escribe en “Efectivo devuelto” lo que el responsable te devolvió en billetes.",
          "Comprueba que el cuarto recuadro diga “Cuadra”. Si dice “Falta rendir” o “Excedido”, el monto que muestra ese mismo recuadro es exactamente lo que baila.",
          "Deja marcada la casilla “Promover gastos aprobados al módulo Gastos” y pulsa “Aprobar y liquidar”.",
        ],
        advertencia:
          "Cualquiera puede abrir la rendición y aprobar o rechazar comprobantes uno a uno, pero **cerrarla es de gerencia**: sin rol admin o gerente verás el candado “Solo gerencia puede aprobar rendiciones” y los botones “Observar” y “Aprobar y liquidar” quedan apagados.",
      },
      {
        titulo: "Crear el fondo de alguien nuevo (chofer, gerente o administrativo)",
        pasos: [
          "Entra a Caja chica → pestaña 💰 Fondos y pulsa “+ Nuevo fondo”.",
          "**Primero elige el tipo**: 🧑‍✈️ Conductor, 🧑‍💼 Personal administrativo, 👤 Usuario del ERP o 📌 Otro. Es lo que decide qué lista de personas te ofrece después y a qué ficha queda ligado el fondo.",
          "Elige a la persona en la lista. Su nombre, DNI, cargo y área se completan solos. (Con el tipo “Otro” no hay lista: el nombre se escribe a mano.)",
          "Revisa el “Centro de costo / área”. Para un administrativo viene de su ficha en Personal administrativo; para un chofer es Operaciones.",
          "Fija el “Tope en la calle” (0 = sin tope) y los “Días para rendir”. Estos dos son los que después lo bloquean si se pasa. El ERP te sugiere 7 días para la calle y 15 para oficina, pero puedes cambiarlos.",
          "Si el efectivo sale siempre de una cuenta concreta, elígela en “Cuenta de tesorería”.",
          "Guarda. El fondo nace activo y ya puedes entregarle dinero.",
        ],
        advertencia:
          "Cada persona puede tener **un solo fondo activo**: si intentas crearle un segundo, el ERP te lo impide (partir su saldo en dos dejaría sin efecto la regla de bloqueo). Y no borres fondos de gente que ya no trabaja contigo: usa “Desactivar”. Borrar te dejaría sin el historial de lo que se le entregó y de lo que rindió.",
      },
      {
        titulo: "Registrar un comprobante desde el ERP (sin la app del conductor)",
        pasos: [
          "Entra a Caja chica → pestaña 🧾 Rendiciones y busca tu rendición. Tiene que estar **Abierta** u **Observada**.",
          "Pulsa “+ Comprobante” en su fila.",
          "Elige la categoría. Arriba salen primero las que van con el tipo de responsable del fondo: las de oficina si es administrativo, las de calle si es chofer.",
          "Pon la fecha del gasto y el **monto total** (el que dice la boleta, con IGV incluido). El botón “18 %” calcula solo el IGV contenido si lo necesitas.",
          "Escribe una descripción que se entienda en tres meses: “qué se compró y para qué”.",
          "Completa tipo de comprobante, RUC, serie y número si la boleta los trae. Sin RUC no hay crédito fiscal.",
          "Adjunta la foto o el PDF. Si de verdad no hubo papel, marca “No hubo comprobante” — queda señalado para que el contador lo mire aparte.",
          "Si el gasto es de un servicio concreto, elígelo en “Servicio (opcional)”: eso es lo que lo mete en el costo real de ese servicio. Si es un vehículo, elige la placa.",
          "Pulsa “Registrar comprobante”. Queda en estado *Pendiente* esperando revisión.",
        ],
        advertencia:
          "Si el monto se pasa de lo que te queda de la entrega, el ERP te avisa pero te deja registrarlo: se entiende que pusiste de tu bolsillo y al liquidar queda como reembolso a tu favor. Lo que NO se puede es agregar comprobantes a una rendición ya enviada a revisión.",
      },
    ],
    relacionadas: [
      { etiqueta: "Gastos · dónde terminan estos comprobantes", href: "/gastos" },
      { etiqueta: "Personal administrativo · de ahí sale el área de cada responsable", href: "/personal-administrativo" },
      { etiqueta: "Tesorería · el resto del dinero que sale", href: "/tesoreria" },
      { etiqueta: "Finanzas · el total de egresos", href: "/finanzas" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // GASTOS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "gastos",
    rutas: ["/gastos"],
    titulo: "Gastos · cuánto cuesta operar y cuánto ganas de verdad",
    resumen:
      "Es la vista única de TODO lo que gastas: los gastos directos que cargas aquí más lo que ya viene de combustible, mantenimiento, neumáticos, caja chica y gastos generales. Y la segunda pestaña te dice, servicio por servicio, cuánto cobraste, cuánto costó y cuánto quedó.",
    paraQueSirve: [
      "Ver el gasto total real de la empresa en un solo número, sin sumar seis pantallas a mano.",
      "Cargar un peaje, un viático o un pago a un tercero y atarlo al servicio y a la placa que lo generó.",
      "Saber si un servicio de S/ 960 te dejó plata o te la quitó.",
      "Detectar servicios ejecutados a los que nadie les cargó ningún costo.",
    ],
    conceptos: [
      "costo_directo",
      "margen",
      "margen_real",
      "prorrateo",
      "amortizacion",
      "centro_costo",
      "estado_admin",
      "regla_oro",
    ],
    faqs: [
      {
        pregunta: "Antes /gastos y /finanzas me daban totales distintos. ¿Por qué, y por qué ahora cuadran?",
        respuesta:
          "Porque cada pantalla sumaba un conjunto distinto de cosas, y ninguna de las dos estaba mintiendo: estaban contando universos diferentes.\n\nLo que faltaba era esto: **los neumáticos, la caja chica y los gastos generales** (planilla, alquiler, tributos) no entraban en la vista central de egresos. Cada módulo iba por su lado y la resta no daba.\n\nHoy las dos pantallas leen **exactamente el mismo conjunto de egresos**. Por eso la banda azul de arriba (“Gasto total real (todos los módulos)”) lleva debajo la línea “6 fuentes · mismo conjunto que v_egresos, cuadra con /finanzas”: es literalmente la misma suma que el “Egreso total” de Finanzas.\n\nSi todavía ves una diferencia, casi siempre es por el filtro de fechas o de estado que tienes puesto en una de las dos. Quita los filtros antes de comparar.",
      },
      {
        pregunta: "¿Qué es el “margen real” y en qué se diferencia del margen que veo en las tarjetitas de arriba?",
        respuesta:
          "**Margen = lo que cobraste − lo que costó.** La diferencia está en qué se cuenta como “costó”:\n\n• **“Margen rápido por reserva”** (las tarjetas verdes/rojas del medio) mira **solo los gastos directos** que cargaste a mano en esta pantalla. Es un vistazo rápido, no la verdad completa.\n\n• **“Margen real”** (pestaña 📈 Rentabilidad por servicio) cuenta **todo lo que está atado a ese servicio**: gastos directos + combustible + mantenimiento + caja chica + gastos generales + lo que te facturó el tercerizado si el servicio fue subcontratado. Esa es la cifra que sirve para decidir si subes el precio o dejas de hacer esa ruta.\n\nEjemplo: cobras S/ 1,120 por un servicio. Cargaste S/ 120 de peajes → el margen rápido dice S/ 1,000. Pero si además hay S/ 380 de combustible imputados y GRIJALVA TOURS te facturó S/ 500 por poner la unidad, el **margen real** es S/ 120. Eso es otra conversación.\n\nOjo: solo cuenta el costo que alguien **ató a ese servicio**. Un gasto real que quedó sin reserva suma al total de la empresa pero no baja este margen.",
      },
      {
        pregunta: "Un servicio del año pasado me sale con un margen buenísimo y sé que no fue así. ¿Por qué?",
        respuesta:
          "Porque a ese servicio **nunca se le ató su costo real**, así que el ERP resta poco y el margen sale inflado.\n\nUn viaje propio, con su tanque lleno y su cambio de aceite, puede aparecer como si hubiera costado casi nada si nadie le imputó esos costos.\n\n**Lo que hoy sí se le puede atar a un servicio:** los gastos directos que cargas en esta pantalla eligiendo su “Reserva / Servicio”, los gastos de caja chica que el chofer registró indicando el servicio desde su app, la parte de gastos generales que se le imputó, y lo que te facturó el tercerizado.\n\n**Lo que todavía no:** las pantallas de Combustible y Mantenimiento aún no tienen un campo para elegir el servicio, así que esos consumos suman al gasto total de la empresa y al costo de la placa, pero no bajan solos el margen de un viaje concreto. Si te importa que un tanque baje el margen de un servicio, cárgalo como gasto directo con su reserva.\n\nLa señal para detectar los servicios sospechosos está en la pestaña 📈 Rentabilidad por servicio: el KPI **“⚠️ Sin costo registrado”** cuenta los que no tienen ni un egreso. Si un servicio está ahí, su margen no significa nada. Compara periodos completos, no un servicio antiguo contra uno nuevo.",
      },
      {
        pregunta: "¿Por qué los neumáticos no le bajan el margen a ningún servicio?",
        respuesta:
          "Es a propósito. Un juego de neumáticos no es costo de *un* viaje: es costo **del vehículo**, y se consume a lo largo de miles de kilómetros y decenas de servicios.\n\nRepartirlo entre servicios exige decidir un criterio (¿por kilómetro?, ¿por día?, ¿por pasajero?) y **ese criterio es una decisión contable, no un dato que el sistema pueda adivinar**. Si tu contador quiere que se reparta de una forma concreta, eso se conversa y se define.\n\nLo que sí hace el ERP: los neumáticos **sí cuentan** en el gasto total de la empresa y en el costo de la placa. Solo no se descuentan de un servicio suelto.",
      },
      {
        pregunta: "Hay filas que no puedo editar ni borrar. ¿Por qué?",
        respuesta:
          "Porque no nacieron aquí. Esta pantalla junta seis orígenes y cada gasto se edita **en el módulo que lo creó**:\n\n• ⛽ Combustible → módulo Combustible\n• 🔧 Mantenimiento → módulo Mantenimiento\n• 🛞 Neumáticos → módulo Neumáticos\n• 🧾 Caja chica → módulo Caja chica\n• 🏢 Gastos generales → Tesorería, pestaña 💼 Planilla y admin.\n\nSolo los **💸 Gastos directos** (los que creas con “+ Nuevo gasto directo”) se editan con ✏️ y se borran con ✕ desde aquí. Los cuatro primeros traen un botón **“Editar en módulo →”** que te lleva al sitio correcto. Las filas de **Gastos generales** muestran un guion: esas se corrigen entrando a Tesorería → Planilla y admin.\n\nEs la misma idea de siempre: cada monto tiene un solo dueño. Si se pudiera editar desde dos sitios, tarde o temprano dirían cosas distintas.",
      },
      {
        pregunta: "Registré un gasto de un servicio que ya se facturó al cliente. ¿Está mal?",
        respuesta:
          "No, regístralo igual. El aviso ámbar que te sale (“Este servicio ya está facturado / cobrado”) solo te está avisando de la consecuencia: **ese gasto ya no se le puede cobrar al cliente**, porque el comprobante de ese periodo ya salió.\n\nO sea: el gasto es real y tiene que estar en el sistema, pero **se come tu margen** en vez de trasladarse al cliente. Esa es exactamente la información que necesitas para no repetirlo: si te pasa seguido, el problema es que estás liquidando antes de tener todos los costos.",
      },
      {
        pregunta: "Un gasto de caja chica, ¿no se está contando dos veces?",
        respuesta:
          "No. De caja chica **solo entran aquí los comprobantes que todavía NO se promovieron al libro de gastos**.\n\nCuando apruebas una rendición con la casilla “Promover gastos aprobados al módulo Gastos” marcada, esos comprobantes pasan a ser gastos normales y **dejan de contarse por el lado de caja chica**. El mismo sol aparece en un solo sitio, antes o después de la promoción, nunca en los dos.",
      },
      {
        pregunta: "¿Qué es el filtro “Todo el ciclo de liquidación”?",
        respuesta:
          "Te deja ver el gasto según en qué punto está el servicio al que se cargó, del lado del cliente:\n\n• **Sin servicio asignado** — gasto que no está atado a ningún viaje (administrativo, o alguien olvidó ponerlo).\n• **Servicio por liquidar** — ya se hizo el viaje pero no se cerró el periodo. Aquí todavía puedes trasladar el costo al cliente.\n• **Ya liquidado / Ya facturado / Ya cobrado** — el gasto llegó tarde: se come tu margen.\n\nEs la forma rápida de responder “¿cuánto se me está escapando por registrar los costos después de facturar?”.",
      },
      {
        pregunta: "¿Qué es el KPI “⚠️ Sin costo registrado” de la pestaña Rentabilidad?",
        respuesta:
          "Cuenta los servicios ya finalizados a los que **nadie les cargó un solo egreso**. Ni un peaje, ni un galón de combustible, ni la factura del tercero.\n\nNo significa que fueran gratis: significa que su margen es mentira. Un servicio con ingreso de S/ 960 y costo cero va a mostrar 100 % de margen y te va a hacer creer que esa ruta es una mina de oro.\n\nSi ese número es alto, la prioridad no es analizar márgenes: es cerrar el registro de costos.",
      },
    ],
    comoHacer: [
      {
        titulo: "Registrar un gasto directo y atarlo al servicio",
        pasos: [
          "Pulsa “+ Nuevo gasto directo”.",
          "En “Tipo de gasto directo” elige la categoría (Peajes, Viáticos, Estacionamiento, Multa / papeleta, Conductor por servicio, Pago empresa terc.…). La categoría define cómo se clasifica después. Combustible, mantenimiento y neumáticos NO están aquí a propósito: van en sus módulos, y los cuatro botones de acceso directo de arriba te llevan.",
          "En “Datos del gasto” pon la Fecha, el Monto S/ y una Descripción que se entienda dentro de seis meses (“Peaje Serpentín – ida turno noche”, no “peaje”).",
          "En “Estado” marca ✅ Pagado si ya salió la plata, ⏳ Pendiente si todavía la debes.",
          "Baja a “Vincular a” y en “Reserva / Servicio” elige el servicio al que pertenece. ESTE ES EL PASO QUE IMPORTA: sin reserva, el gasto suma al total de la empresa pero no baja el margen de ningún servicio.",
          "Elige también el Vehículo (por ejemplo CWQ-400) y, si aplica, el Conductor, la Empresa tercerizada o el Proveedor.",
          "Al elegir reserva y monto, abajo aparece un recuadro con el margen estimado de ese servicio incluyendo el gasto que estás por guardar. Míralo antes de guardar.",
          "Pulsa “Guardar gasto”.",
        ],
        advertencia:
          "Si el ERP te avisa de que ese servicio ya está facturado o cobrado, guarda igual: el gasto es real. Solo ten claro que ya no se le puede trasladar al cliente.",
      },
      {
        titulo: "Ver cuánto ganó de verdad un servicio",
        pasos: [
          "Cambia a la pestaña “📈 Rentabilidad por servicio”.",
          "Arriba tienes cinco cifras del conjunto que estés viendo: 🟢 Ingreso total, 🔴 Costo real total, 💰 Margen total, 📊 Margen % y ⚠️ Sin costo registrado.",
          "Pulsa “☐ Solo servicios liquidados al cliente” si quieres comparar únicamente servicios ya cerrados: son los únicos con el costo completo.",
          "En la tabla, cada fila es un servicio con su Ingreso, su Costo real, su Margen y su Margen %. Ábrela para ver de dónde sale cada sol del costo (gastos, combustible, mantenimiento, caja chica, generales, factura del tercero).",
          "Pulsa “⬇️ Exportar” arriba a la derecha si quieres cruzarlo en Excel con tus precios por ruta.",
        ],
        advertencia:
          "El Margen % de la cabecera se calcula sobre el ingreso total del conjunto, no promediando los porcentajes fila a fila. Es a propósito: promediar le daría el mismo peso a un servicio de S/ 200 que a uno de S/ 20,000.",
      },
    ],
    relacionadas: [
      { etiqueta: "Caja chica · de dónde vienen los tickets del chofer", href: "/caja-chica" },
      { etiqueta: "Tesorería · las facturas de proveedores y la planilla", href: "/tesoreria" },
      { etiqueta: "Combustible · el gasto que no se edita aquí", href: "/combustible" },
      { etiqueta: "Mantenimiento · el otro gasto que vive en su módulo", href: "/mantenimiento" },
      { etiqueta: "Liquidaciones · el cierre de periodo que cambia el margen", href: "/liquidaciones" },
      { etiqueta: "Finanzas · el mismo total, del lado del dinero", href: "/finanzas" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // FINANZAS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "finanzas",
    rutas: ["/finanzas"],
    titulo: "Finanzas · lo que entra, lo que sale y lo que hay en el banco",
    resumen:
      "El resumen de tres caras del dinero de AFA: lo que te deben tus clientes (Ingresos), todo lo que gastas (Egresos) y cuánto tienes en cada cuenta (Tesorería).",
    paraQueSirve: [
      "Ver de un vistazo cuánto tienes por cobrar y cuánto de eso ya está vencido.",
      "Registrar el cobro de una factura o un pago suelto a un proveedor.",
      "Comparar el total de egresos contra lo que ves en /gastos: tienen que dar lo mismo.",
      "Consultar el saldo de cada cuenta de banco o caja según lo que el ERP tiene registrado.",
    ],
    conceptos: [
      "cuentas_por_cobrar",
      "cuentas_por_pagar",
      "aging",
      "saldo",
      "vencimiento",
      "devengado",
      "percibido",
      "regla_oro",
    ],
    faqs: [
      {
        pregunta: "¿En qué se diferencia esta pantalla de /tesoreria y de /gastos?",
        respuesta:
          "Las tres miran el mismo dinero desde alturas distintas:\n\n• **Finanzas (aquí)** — el resumen. Cuánto te deben, cuánto gastas, cuánto hay en el banco. Es la foto para tomar decisiones.\n• **Tesorería** — el detalle operativo del dinero que SALE: aprobar facturas, armar lotes de pago, depositar detracciones, conciliar el banco. Es donde se trabaja.\n• **Gastos** — el detalle del gasto por vehículo y por servicio, para saber si ganas o pierdes en cada viaje.\n\nSi buscas “cuánto tengo que pagar esta semana”, ve a Tesorería. Si buscas “cuánto me deben”, quédate aquí.",
      },
      {
        pregunta: "¿Qué es la “antigüedad de cuentas por cobrar” (Vigente, 0-30, 31-60, 61-90, +90)?",
        respuesta:
          "Es tu deuda de clientes ordenada **por cuántos días llevan pasados de la fecha de vencimiento**.\n\n• **Vigente** — todavía no vence. Normal.\n• **0-30 d** — se pasó, pero es reciente. Una llamada lo arregla.\n• **31-60 d y 61-90 d** — cobranza en serio.\n• **+90 d** — plata que a estas alturas hay que considerar dudosa.\n\nNo es lo mismo que te deban S/ 50,000 todos vigentes que S/ 50,000 con la mitad en +90 días. El primer caso es operación normal; el segundo es un problema de caja que va a llegar en tres semanas.",
      },
      {
        pregunta: "Pulsé “Registrar cobro” en una factura. ¿Qué pasó exactamente?",
        respuesta:
          "Se registró un cobro por el monto que escribiste y se **aplicó a esa factura**, bajándole el saldo.\n\nSi cobraste solo una parte, la factura queda con el resto pendiente y sigue apareciendo en la lista con el saldo menor. Cuando el saldo llega a cero, deja de salir.\n\nEl saldo nunca se marca a mano: siempre es **total de la factura menos los cobros aplicados**. Por eso no hay un botón de “marcar como cobrada”.",
      },
      {
        pregunta: "El “Egreso total” de aquí no coincide con lo que veo en Contabilidad. ¿Cuál está bien?",
        respuesta:
          "Las dos, porque miden cosas distintas y no se pueden sumar:\n\n• **Aquí (plano de gestión)**: cuánto costó operar. Combustible, peajes, sueldos, mantenimiento, caja chica. Es la pregunta del dueño: *¿cuánto me cuesta mover los buses?*\n\n• **En Contabilidad (plano fiscal)**: las facturas de compra con su IGV, para el Registro de Compras y la declaración. Es la pregunta de la SUNAT: *¿qué comprobantes tienes?*\n\nUn mismo gasto puede estar en los dos planos (el combustible con su factura del grifo) o solo en uno (un peaje sin comprobante está en gestión pero no da crédito fiscal). Sumarlos contaría el mismo sol dos veces, y por eso se llevan aparte a propósito.",
      },
      {
        pregunta: "El saldo que muestra una cuenta de tesorería no es el que veo en mi banco.",
        respuesta:
          "El saldo de aquí es **saldo inicial + todos los movimientos que el ERP tiene registrados**. No se conecta con el banco.\n\nSi difiere, es que hay movimientos reales que el ERP no conoce (o al revés). La herramienta para cazar esa diferencia es la **conciliación bancaria** en Tesorería: subes el extracto del banco y el ERP te dice exactamente qué cargos no puede justificar.",
      },
      {
        pregunta: "Me sale “No se pudo cargar. ¿Corriste supabase/finanzas-00..02?”. ¿Qué hago?",
        respuesta:
          "Es un mensaje técnico: significa que **faltan por instalar las tablas de finanzas en la base de datos**. No es un error tuyo ni se arregla desde la pantalla.\n\nAvísale a quien administra el sistema con ese texto tal cual. Hasta entonces esta pantalla no va a mostrar datos.",
      },
    ],
    comoHacer: [
      {
        titulo: "Registrar el cobro de una factura",
        pasos: [
          "Entra a la pestaña “ingresos”. La tabla lista solo las facturas con saldo pendiente.",
          "Busca la factura por su serie y número y pulsa “Registrar cobro”.",
          "Te propone el saldo completo. Si el cliente pagó solo una parte, cámbialo por lo que de verdad entró.",
          "Acepta. El saldo baja solo y la antigüedad se recalcula.",
        ],
        advertencia:
          "Registra el monto que efectivamente entró a tu cuenta. Si el cliente te retuvo la detracción, lo que entró es menos que el total de la factura — el resto está en tu cuenta del Banco de la Nación y se controla en Facturación.",
      },
      {
        titulo: "Registrar un pago suelto a un proveedor",
        pasos: [
          "Entra a la pestaña “tesoreria”. En el bloque “Cuentas por pagar (proveedores)” están las facturas con saldo.",
          "Pulsa “Pagar” en la fila del proveedor y escribe el monto que le transferiste.",
          "El saldo de ese comprobante baja solo.",
        ],
        advertencia:
          "Este atajo sirve para un pago suelto y urgente. Para la corrida normal de pagos usa Tesorería → Lotes de pago: ahí queda constancia de quién aprobó, del archivo que se subió al banco y del n.º de operación.",
      },
    ],
    relacionadas: [
      { etiqueta: "Tesorería · aprobar, pagar y conciliar", href: "/tesoreria" },
      { etiqueta: "Gastos · el mismo egreso, por vehículo y servicio", href: "/gastos" },
      { etiqueta: "Facturación · de dónde salen las cuentas por cobrar", href: "/facturacion" },
      { etiqueta: "Contabilidad · el plano fiscal", href: "/contabilidad" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CONTABILIDAD
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "contabilidad",
    rutas: ["/contabilidad"],
    titulo: "Contabilidad · lo que le tienes que mostrar a la SUNAT",
    resumen:
      "El lado fiscal del negocio: el registro de las facturas de compra, cuánto IGV pagas o te devuelven en el mes, los asientos contables que salen solos de esos documentos, y la depreciación de tus buses.",
    paraQueSirve: [
      "Tener ordenadas las facturas de compra que sustentan tu crédito fiscal.",
      "Saber antes de fin de mes cuánto IGV te va a tocar pagar.",
      "Entregarle a tu contador los asientos ya armados en vez de un Excel suelto.",
      "Llevar la depreciación de los vehículos mes a mes sin acordarte a mano.",
    ],
    conceptos: [
      "asiento",
      "debe_haber",
      "plan_cuentas",
      "registro_compras",
      "registro_ventas",
      "igv",
      "credito_fiscal",
      "periodo_contable",
      "devengado",
      "amortizacion",
      "sunat",
      "comprobante",
    ],
    faqs: [
      {
        pregunta: "Nunca llevé contabilidad. ¿Qué es un “asiento”?",
        respuesta:
          "Un **asiento** es la forma en que la contabilidad anota un hecho económico. Nada más.\n\nCada vez que pasa algo con plata —vendes, compras, pagas, cobras— se escribe una anotación que dice qué día fue, qué pasó (la “glosa”) y qué cuentas se movieron y por cuánto.\n\nPiénsalo como el diario del negocio: si mañana un auditor pregunta “¿qué pasó el 12 de agosto?”, el asiento se lo cuenta.\n\nAquí no tienes que escribir ninguno. **Los asientos se derivan solos de los documentos** que ya cargaste. El botón “Generar asientos faltantes” (pestaña asientos) recorre tus facturas de venta y tus facturas de compra y crea el que falte de cada una; los de depreciación los crea el botón “Depreciar [mes]” de la pestaña activos.",
      },
      {
        pregunta: "¿Y qué es el “debe” y el “haber”? ¿Por qué siempre son iguales?",
        respuesta:
          "Es un truco de control con 500 años de antigüedad y sigue funcionando: **cada anotación se escribe dos veces, en dos columnas, y las dos columnas tienen que dar el mismo total**. Si no cuadran, algo se escribió mal.\n\nLa idea de fondo: todo movimiento de dinero tiene un origen y un destino.\n\nEjemplo con una factura tuya de S/ 1,120 a un cliente:\n• En el **DEBE** va S/ 1,120 en “el cliente me debe”. (aumentó lo que te deben)\n• En el **HABER** van S/ 949.15 en “ventas” y S/ 170.85 en “IGV por pagar”. (de dónde viene ese derecho de cobro)\n\n1,120 = 949.15 + 170.85. Cuadra.\n\n**No tienes que entender qué cuenta va en cada lado.** El ERP lo hace y tu contador lo revisa. Lo único que te conviene saber es que si un asiento no cuadra, hay un error, y que las columnas Debe y Haber de la tabla siempre deben coincidir.",
      },
      {
        pregunta: "¿Qué es el “registro de compras” y para qué me lo pide la SUNAT?",
        respuesta:
          "Es **la lista ordenada y numerada de todas las facturas que te emitieron a ti**, mes a mes: fecha, RUC del proveedor, serie y número, base, IGV y total.\n\nLa SUNAT te lo exige por una razón muy concreta: **es lo que sustenta tu crédito fiscal**. Cuando compras combustible y pagas S/ 180 de IGV, ese IGV lo puedes descontar del IGV que cobraste en tus ventas — pero solo si la factura está registrada aquí, con todos sus datos y dentro del plazo.\n\nSi una compra no está en el registro, ese IGV lo pierdes: se convierte en costo puro. Y si el registro tiene errores u omisiones, la SUNAT puede desconocerte el crédito de todo el periodo y aplicar multa.\n\nLa pestaña **compras** de esta pantalla es ese registro. Cada fila que ves es una factura que sí va a sustentar tu crédito.",
      },
      {
        pregunta: "En la pestaña IGV veo tres números. ¿Qué me están diciendo?",
        respuesta:
          "Es la cuenta del IGV del mes, y funciona como una resta:\n\n• **IGV ventas** — el IGV que le cobraste a tus clientes. Ese dinero **no es tuyo**, lo cobraste para la SUNAT.\n• **IGV compras** — el IGV que tú pagaste al comprar. Ese sí lo puedes descontar (es tu **crédito fiscal**).\n• **IGV a pagar** — la diferencia. Es lo que le tienes que girar a la SUNAT este mes.\n\nSi compraste más IGV del que cobraste (un mes en que compraste un bus, por ejemplo), no te devuelven plata: el saldo a favor **se arrastra** al mes siguiente. Aquí verás S/ 0.00 en “a pagar”, que es correcto, pero el arrastre lo lleva tu contador.\n\n**Este número es una referencia para que no te agarre desprevenido.** La declaración la presenta tu contador y puede diferir por ajustes que él conoce.",
      },
      {
        pregunta: "¿Tengo que teclear los asientos yo?",
        respuesta:
          "No, y tampoco deberías. Pulsa **“Generar asientos faltantes”** y el ERP recorre tus facturas de venta y tus facturas de compra y crea el asiento que falte de cada una.\n\nEs seguro pulsarlo varias veces: los documentos que ya tienen asiento se saltan, no se duplican.\n\nEsto es la aplicación de la misma regla de siempre: el monto vive en el documento, y el asiento lo *deriva*. Si tecleara los asientos a mano, tarde o temprano dirían algo distinto de las facturas.",
      },
      {
        pregunta: "¿Qué es depreciar y por qué tengo que hacerlo todos los meses?",
        respuesta:
          "Un bus no se “gasta” el día que lo compras: te sirve durante años y **se va desgastando**. Depreciar es reconocer contablemente ese desgaste mes a mes, en vez de meter todo el costo de golpe.\n\nSi compras una unidad en S/ 240,000 con una vida útil de 60 meses, cada mes se reconocen S/ 4,000 de desgaste. Eso baja tu utilidad del mes (y por tanto el impuesto a la renta) de forma pareja, en vez de destrozarte un mes y dejarte los otros 59 sin costo.\n\nEl botón **“Depreciar [mes]”** calcula y registra la cuota de ese mes para cada activo, y genera su asiento. Si ya lo corriste para ese periodo, no lo repite: puedes pulsarlo sin miedo.\n\n**Si la pestaña activos te sale vacía, el botón no va a hacer nada.** La lista de activos (qué bus, por cuánto se compró, cuántos meses de vida útil) todavía no se carga desde esta pantalla: pídesela a quien administra el sistema.\n\n**La vida útil y el método los define tu contador según la norma tributaria**, no el ERP. Aquí se aplica el método lineal (la misma cuota todos los meses), que es el más común; si tu contador usa otro, díselo.",
      },
      {
        pregunta: "¿Qué es la “Bandeja IA” y por qué está vacía?",
        respuesta:
          "Está pensada para las facturas de proveedor que lleguen **solas por correo**, sin que nadie las tipee: la IA les sacaría el RUC, la serie, el número, el IGV y el total, y quedarían ahí esperando revisión.\n\n**Hoy esa entrada por correo todavía no está conectada**, así que lo normal es ver la bandeja vacía con el aviso de que el pipeline de correo la alimentará. Es una lista de solo lectura: no tiene botones para aprobar ni convertir nada.\n\nMientras tanto, la vía que sí funciona para no tipear es el recuadro **“📎 Leer factura de proveedor”** de la pestaña compras: le das el XML, el PDF o la foto y él extrae los datos y registra la compra.",
      },
      {
        pregunta: "¿Esto reemplaza a mi contador?",
        respuesta:
          "**No.** Y conviene tenerlo clarísimo.\n\nLo que hace el ERP: mantiene ordenados los documentos, calcula lo que se puede calcular sin criterio (el IGV de una factura, la cuota lineal de depreciación) y arma los asientos derivados para que tu contador no empiece de cero.\n\nLo que sigue siendo de tu contador: **presentar las declaraciones**, decidir las tasas y los códigos de detracción vigentes, definir la vida útil de los activos, resolver los arrastres de saldo a favor, el criterio de prorrateo y cualquier tratamiento particular.\n\nDicho corto: esta pantalla es para que llegues a tu contador con todo ordenado, no para prescindir de él.",
      },
    ],
    comoHacer: [
      {
        titulo: "Cerrar el mes contable",
        pasos: [
          "Arriba a la derecha elige el mes que vas a cerrar en el selector de periodo.",
          "Pestaña compras: revisa que estén todas las facturas de proveedor del mes. Las que falten, cárgalas — pulsando el recuadro punteado de arriba y eligiendo el XML o la foto, o a mano desde Tesorería.",
          "Pestaña asientos: pulsa “Generar asientos faltantes”. Comprueba que las columnas Debe y Haber de cada asiento coincidan.",
          "Pestaña activos: pulsa “Depreciar [mes]”. Solo una vez por mes; si ya se corrió, no hace nada.",
          "Pestaña igv: mira el IGV a pagar del periodo y anótalo para prever la caja.",
          "Manda todo a tu contador para que declare.",
        ],
        advertencia:
          "El IGV que ves aquí es una referencia calculada con lo que hay cargado en el ERP. Si faltan facturas de compra por registrar, el número va a salir más alto de lo que realmente te toca pagar.",
      },
      {
        titulo: "Cargar la factura de un proveedor leyéndola del archivo",
        pasos: [
          "Entra a la pestaña compras.",
          "Pulsa el recuadro punteado “📎 Leer factura de proveedor (XML SUNAT o PDF/foto)” y elige el archivo: el XML que emite SUNAT es lo más exacto, pero también acepta PDF o una foto.",
          "Espera el mensaje azul de arriba. El ERP extrae RUC, serie, número, IGV y total, y comprueba que no exista ya registrada para no duplicarla.",
          "Verifica en la tabla que el Emisor, el Subtotal, el IGV y el Total sean los correctos.",
        ],
        advertencia:
          "De una foto torcida o con reflejos la lectura puede equivocarse en un dígito. Si el monto que muestra no es el que ves impreso, corrígelo desde Tesorería → Cuentas por pagar antes de que ese número se propague al IGV y a los asientos.",
      },
    ],
    relacionadas: [
      { etiqueta: "Tesorería · registrar y pagar las facturas de compra", href: "/tesoreria" },
      { etiqueta: "Facturación · tus comprobantes de venta", href: "/facturacion" },
      { etiqueta: "Finanzas · el plano de gestión", href: "/finanzas" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // FACTURACIÓN
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "facturacion",
    rutas: ["/facturacion"],
    titulo: "Facturación · los comprobantes que le emites al cliente",
    resumen:
      "Aquí se registran y controlan las facturas, boletas y notas de crédito que AFA emite: cuánto facturaste, qué está cobrado, qué está vencido y qué detracciones te falta que el cliente sustente.",
    paraQueSirve: [
      "Llevar el control de tus comprobantes de venta con su serie, número y estado.",
      "Saber cuánto te van a depositar de verdad cuando hay detracción de por medio.",
      "Ver qué facturas están vencidas y hay que salir a cobrar.",
      "Emitir notas de crédito cuando hay que anular o rebajar algo ya facturado.",
    ],
    conceptos: [
      "factura",
      "boleta",
      "nota_credito",
      "serie_numero",
      "igv",
      "detraccion",
      "spot",
      "banco_nacion",
      "cuentas_por_cobrar",
      "vencimiento",
      "sunat",
      "tipo_cambio",
    ],
    faqs: [
      {
        pregunta: "¿Por qué el cliente me deposita menos de lo que facturé?",
        respuesta:
          "Casi siempre por la **detracción**, y no te están pagando de menos: te están pagando en dos partes.\n\nLa detracción (el sistema se llama **SPOT**) obliga a tu cliente a **separar un porcentaje de tu factura y depositarlo directamente en una cuenta a nombre de AFA en el Banco de la Nación**, en vez de dártelo a ti. En transporte de personal ese porcentaje es del **10 %**.\n\nCon una factura de **S/ 1,120**:\n• El cliente te transfiere a tu cuenta del BCP: **S/ 1,008**.\n• El cliente deposita en tu cuenta del Banco de la Nación: **S/ 112**.\n• Total que salió de su bolsillo: S/ 1,120. **No perdiste nada.**\n\nEsos S/ 112 son tuyos, pero **solo puedes usarlos para pagar impuestos** (IGV, renta, ESSALUD, multas). Es el mecanismo que la SUNAT usa para asegurarse de cobrar.\n\nDos cosas que sí debes vigilar:\n1. **Que el cliente de verdad haya depositado.** Pídele la constancia y anota su número de operación en el comprobante. Si no depositó, esa plata no está en ninguna parte.\n2. **Que no te falte caja.** Si facturas S/ 100,000 al mes, S/ 10,000 no van a estar disponibles para pagar sueldos o combustible. Eso hay que preverlo.",
      },
      {
        pregunta: "¿Cuándo lleva detracción una factura y cuándo no?",
        respuesta:
          "En esta pantalla el ERP te habilita la casilla **“Detracción 10%”** cuando el total llega o pasa los S/ 700. Por debajo de ese monto la casilla queda gris y al lado te dice “Solo si total ≥ S/700”.\n\nEsa es la regla general del Anexo 3 para servicios como el transporte de personal. Pero **la tasa, el umbral y el código dependen del servicio exacto que estés vendiendo**, y cambian por Resolución de Superintendencia.\n\n**Confírmalo con tu contador**, sobre todo si empiezas a facturar algo distinto del transporte de personal (carga, alquiler de unidad sin conductor, etc.): ahí la regla y el porcentaje son otros.",
      },
      {
        pregunta: "La factura tiene un chip amarillo que dice “⚠️ Pendiente” en la columna Detracción. ¿Qué me falta?",
        respuesta:
          "Falta el **número de operación del depósito**. El chip mira solo eso: si está vacío, aparece en amarillo; en cuanto lo escribes, pasa a verde “✅ Depositada”.\n\nEse número lo tiene tu cliente: es la constancia que le devolvió el Banco de la Nación al hacer el depósito. Pídesela y anótala en el comprobante junto con la fecha.\n\nEs importante y tiene plazo: el aviso rojo de arriba te lo recuerda (“plazo legal: 5.º día hábil del mes siguiente”). Sin la constancia no puedes probar que el depósito existió, y a la larga eso te lo cuestionan a ti.",
      },
      {
        pregunta: "¿Qué es una nota de crédito y cuándo la uso?",
        respuesta:
          "Una **nota de crédito** es el comprobante que sirve para **corregir hacia abajo** una factura que ya emitiste. Una factura emitida no se borra ni se edita: se corrige emitiendo otro documento que la referencia.\n\nEn la pantalla eliges uno de tres motivos:\n• **Anulación total** — la factura entera no debía existir (la emitiste al cliente equivocado, el servicio no se prestó).\n• **Descuento / rebaja** — el monto era más alto de lo pactado.\n• **Devolución** — se prestó solo una parte del servicio.\n\nAl marcar “Nota de crédito” te pide el comprobante que corrige (por ejemplo F001-00025). Esa referencia es obligatoria: sin ella, la nota no se ata a nada.",
      },
      {
        pregunta: "¿Qué son la “serie” y el “número”?",
        respuesta:
          "Es la matrícula del comprobante, y es única: no puede haber dos iguales.\n\n• **Serie** — cuatro caracteres que identifican el tipo y el punto de emisión. Por convención: **F001** para facturas, **B001** para boletas, **FC01** para notas de crédito.\n• **Número** — el correlativo, que va subiendo de uno en uno dentro de esa serie.\n\nJuntos se escriben **F001-00025**. Así se identifica ese comprobante ante la SUNAT, ante tu cliente y en tu registro de ventas. Los correlativos **no pueden tener huecos**: si te saltas un número, tu contador va a tener que justificarlo.",
      },
      {
        pregunta: "¿Qué diferencia hay entre Emitida, Enviada y Cobrada?",
        respuesta:
          "Es el recorrido del comprobante:\n\n• **Emitida** — existe, está generada.\n• **Enviada** — ya se la mandaste al cliente y él la tiene.\n• **Cobrada** — la plata entró.\n• **Vencida** — se pasó la fecha de pago y sigue sin cobrarse. El aviso rojo de arriba te las cuenta.\n• **Anulada** — dejó de tener efecto (normalmente porque emitiste una nota de crédito de anulación).\n\nOjo: “Enviada” no es “Cobrada”. Muchas empresas dan por bueno el mes cuando mandaron las facturas, y ahí es donde se acumula la cobranza.",
      },
      {
        pregunta: "¿Qué significa el estado SUNAT (aceptada / rechazada)?",
        respuesta:
          "Es la respuesta de la SUNAT a tu comprobante electrónico. **Aceptada** significa que la validó; **rechazada**, que la observó y ese comprobante no tiene validez tal como está.\n\nSi te sale rechazada, mira el código que te devolvió (se guarda en el campo de al lado): suele ser un dato del cliente mal puesto, un RUC inválido o un cálculo que no cuadra. Hay que corregir y volver a enviar.\n\n**Sé consciente de lo que hace esta pantalla:** aquí se **registra** el estado y se guardan los enlaces al PDF, al XML y al CDR. **El envío electrónico a SUNAT lo hace tu facturador o tu PSE**, no el ERP. Este módulo es el control interno de tus comprobantes, no el emisor.",
      },
      {
        pregunta: "¿Qué es la alerta morada de “Servicios de Despachador pendientes de facturar”?",
        respuesta:
          "Son servicios que ya se ejecutaron y se generaron desde Despachador (los urgentes, los que entran fuera de la programación normal) pero **todavía no tienen ningún comprobante emitido**.\n\nEs plata que trabajaste y no has facturado, y es la fuga clásica: como no entraron por el circuito de siempre, nadie se acuerda de cobrarlos.\n\nEl botón “Ver despachador →” del propio aviso te lleva a revisarlos. Después emítelos aquí, o inclúyelos en la liquidación del periodo de ese cliente.",
      },
    ],
    comoHacer: [
      {
        titulo: "Emitir el comprobante de un periodo ya liquidado",
        pasos: [
          "Lo normal es que la factura nazca sola al aprobar la liquidación del cliente en /liquidaciones. Este procedimiento es para cargarla o corregirla a mano.",
          "Pulsa “+ Nuevo comprobante” y elige el tipo: Factura, Boleta o Nota de Crédito.",
          "Elige el cliente. Si la factura viene de una cotización o de una reserva, elígela: los ítems y el precio se traen solos.",
          "Revisa la serie (F001 para factura) y pon el número correlativo que toca.",
          "Completa los ítems: descripción, cantidad y precio unitario. El subtotal, el IGV y el total se calculan solos.",
          "Si el total llega a S/ 700, marca la casilla “Detracción 10%”. Verás el desglose: cuánto se detrae y cuánto es el neto que te van a depositar.",
          "Pon la fecha de vencimiento según el crédito que le diste al cliente (30, 60 días). Es la que después alimenta la antigüedad de cobranza.",
          "Guarda. Nace en estado “Emitida”.",
        ],
        advertencia:
          "Un comprobante ya emitido no se corrige editándolo: se corrige con una nota de crédito. Editar aquí una factura que ya salió al cliente y ya se declaró te deja el registro de ventas distinto de lo que la SUNAT tiene.",
      },
      {
        titulo: "Registrar el depósito de la detracción que hizo el cliente",
        pasos: [
          "Pídele al cliente la constancia del depósito en el Banco de la Nación.",
          "Busca la factura en la lista: las que faltan tienen el chip amarillo “⚠️ Pendiente” en la columna Detracción.",
          "Pulsa el botón ✏️ de su fila para editarla y baja al bloque de detracción.",
          "Escribe el N° de operación de la constancia y la fecha del depósito.",
          "Guarda. El chip pasa a verde “✅ Depositada” y la factura sale del contador de detracciones pendientes.",
        ],
        advertencia:
          "Si el cliente no te manda la constancia, no la des por hecha. Sin depósito esos soles no están en tu cuenta del Banco de la Nación, y el problema termina siendo tuyo cuando la SUNAT lo revise.",
      },
    ],
    relacionadas: [
      { etiqueta: "Liquidaciones · el paso previo a facturar", href: "/liquidaciones" },
      { etiqueta: "Finanzas · el cobro de estas facturas", href: "/finanzas" },
      { etiqueta: "Contabilidad · el IGV de estas ventas", href: "/contabilidad" },
      { etiqueta: "Tesorería · el lado compra de la detracción", href: "/tesoreria" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LIQUIDACIONES
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "liquidaciones",
    rutas: ["/liquidaciones"],
    titulo: "Liquidaciones · cerrar el mes con el cliente y con el proveedor",
    resumen:
      "Aquí se cierra el periodo: se valoriza todo lo que se ejecutó, se emite el formato de liquidación y conformidad, y recién con el visto bueno se factura al cliente o se le paga al tercerizado.",
    paraQueSirve: [
      "Cerrar un mes o una quincena completa de una pasada, en vez de servicio por servicio.",
      "Aislar a un cliente o a un proveedor con el filtro de arriba, para atenderlo sin leer los otros nueve.",
      "Mandarle al cliente un documento con el detalle de lo que se ejecutó, para que dé su conformidad antes de facturar.",
      "Convertir los servicios que hizo un tercerizado en una cuenta por pagar con su detalle.",
      "Ver en rojo, antes de emitir, qué servicios están mal (sin precio, sin unidad, sin finalizar).",
    ],
    conceptos: [
      "liquidacion_cliente",
      "liquidacion_proveedor",
      "conformidad",
      "tercerizado",
      "periodo_contable",
      "devengado",
      "igv",
      "cuentas_por_cobrar",
      "cuentas_por_pagar",
      "estado_admin",
      "servicio_adicional",
    ],
    faqs: [
      {
        pregunta: "En la valorización veo un renglón naranja que dice ADICIONAL. ¿Qué es?",
        respuesta:
          "Es un servicio que el cliente pidió **por encima de lo contratado** y que se registró como tal en Reservas (botón *Adicional*).\n\nNo se mezcla con las líneas del contrato a propósito, aunque sea la misma ruta:\n\n• Va en **su propio renglón**, aunque coincida la ruta y hasta el precio.\n• Se suma aparte, en **“Adicionales autorizados”**, debajo de *Servicios del periodo*.\n• Sale al **final** del bloque de líneas, no intercalado, para que el cliente lo lea contra los servicios contratados.\n• La descripción arranca con **SERVICIO ADICIONAL**, porque esa descripción se copia a correos y a órdenes de compra, y ahí el color del renglón se pierde.\n\nSi el mes tuvo 22 servicios contratados y 3 adicionales, el formato dice 22 y 3, no 25. Ese es todo el punto.",
      },
      {
        pregunta: "¿Qué diferencia hay entre liquidar al cliente y liquidar al proveedor?",
        respuesta:
          "Son los dos extremos del mismo servicio, y por eso son dos pestañas distintas:\n\n**Al Cliente (facturar)** — plata que ENTRA.\nJuntas los servicios que ejecutaste para un cliente en el periodo, los valorizas al precio pactado y le mandas el formato para que dé su conformidad. Cuando apruebas esa liquidación, **el ERP genera la factura de venta** y esos servicios pasan a ser cuentas por cobrar.\n\n**Al Proveedor (pagar)** — plata que SALE.\nJuntas los servicios que un tercerizado (por ejemplo GRIJALVA TOURS) ejecutó para ti en el periodo, los valorizas al costo pactado y armas el detalle de lo que le vas a pagar. Cuando apruebas esa liquidación, **el ERP genera la factura de compra** (la cuenta por pagar) y aparece en Tesorería para aprobar y pagar.\n\nUn mismo servicio puede tener las dos: le cobras S/ 1,120 al cliente y le pagas S/ 800 a GRIJALVA por poner la unidad. La diferencia es tu margen.\n\n**Ojo con la dirección:** en la pestaña Cliente **tú** emites el documento; en la pestaña Proveedor el documento es el sustento de lo que **él** te va a facturar a ti.",
      },
      {
        pregunta: "¿Qué es la “conformidad” y por qué esperarla antes de facturar?",
        respuesta:
          "La **conformidad** es el visto bueno formal del cliente: “sí, estos servicios se prestaron, este es el detalle correcto, pueden facturar”.\n\nEs el seguro contra el problema clásico del transporte corporativo: facturas S/ 48,000, el cliente descubre en su área tres servicios que dice que no se hicieron, y ahora tienes que emitir una nota de crédito, volver a facturar y esperar otro mes para cobrar.\n\nCon la conformidad al revés: **primero se discute sobre el formato de liquidación, y recién cuando está conforme se factura**. La discusión pasa antes de que haya un comprobante fiscal de por medio.\n\nEn la columna Conformidad ves el estado de cada documento. El botón **✉ Enviar** manda el enlace al cliente para que la firme.",
      },
      {
        pregunta: "Hay grupos en rojo que no me deja seleccionar. ¿Qué pasa?",
        respuesta:
          "Son servicios que **todavía no se pueden liquidar**, y el ERP te lo dice antes de emitir para que no lo descubra el cliente semanas después.\n\nAbre el grupo y verás dos bloques:\n\n• **“No se pueden liquidar todavía”** (rojo) — el motivo exacto, servicio por servicio. Del lado cliente: *Sin precio de venta*, *Sin cliente asignado*, *Ya está en la liquidación #N*, o *Su tarifa va en el servicio #N, que no está en este periodo* (el clásico del turno noche que retorna al día siguiente: mueve el rango de fechas). Del lado proveedor lo mismo con *Sin costo de proveedor* y *Sin empresa tercerizada*. Casi todo se corrige en Programación.\n\nHay tres motivos que hablan del **tramo hermano** y que NO se arreglan poniendo un precio, porque ese día ya lo cobra el otro tramo: *Le falta el enlace ida↔retorno con OS-…* (se arregla con el botón ámbar **Enlazar ida↔retorno**), *Su tarifa va en OS-…, que no entra a este cierre* (ya se facturó en otro documento) y *El enlace ida↔retorno está cruzado*. Ponerles importe factura el día dos veces.\n\n• **“Revisa antes de emitir”** (ámbar) — servicios programados que **no se ejecutaron**. No bloquean: el formato los muestra igual en la columna de programado contra ejecutado, para que el cliente vea qué se hizo y qué no.\n\nQue un servicio no esté finalizado NO impide liquidar el grupo; solo aparece como no ejecutado. Lo que deja la casilla muerta es que el grupo no tenga **ninguna** línea valorizable.",
      },
      {
        pregunta: "Un retorno sale como “Sin precio de venta”, pero su ida ya tiene el precio. ¿Qué hago?",
        respuesta:
          "**No le pongas precio.** Ese retorno va en S/ 0.00 a propósito: AFA cobra **una sola tarifa por los dos tramos del día**, la tarifa está en la ida, y cargarla también en el retorno **factura el día dos veces**.\n\nLo que pasa es que los dos tramos perdieron el enlace que dice que son el mismo día (la columna que los une en Reservas). Sin ese enlace el ERP no ve un servicio de ida y vuelta: ve dos servicios sueltos, y le reclama tarifa al que está en cero.\n\nEl enlace se pierde de dos formas: queda escrito **en un solo lado** (se escribe en dos pasos al generar el programa, y a veces el segundo no llega) o se borra entero al eliminar y volver a crear un tramo.\n\n**Cómo se arregla:** en la barra de arriba aparece el botón ámbar **“Enlazar N par(es) ida↔retorno”**. Ábrelo, revisa que cada par sea el correcto —te muestra los dos códigos, la hora, la ruta y quién lleva el importe— y enlázalos. **No cambia ningún importe**: solo dice que esos dos tramos son el mismo día. Desde ese momento el retorno deja de pedir tarifa en este cierre y en todos los siguientes, y el día vuelve a contarse como **un** servicio.\n\nSi el par no aparece en ese botón es porque no se puede saber cuál va con cuál (por ejemplo, dos móviles de la misma ruta el mismo día): en ese caso se enlaza a mano desde Programación, que es donde se ve la unidad de cada uno.",
      },
      {
        pregunta: "¿Qué pasa exactamente cuando pulso “Facturar” en una liquidación de cliente?",
        respuesta:
          "Te pide confirmación y luego hace tres cosas de golpe:\n\n1. La liquidación pasa a estado **facturada**.\n2. **Se crea la factura de venta** en /facturacion, con las mismas líneas de la liquidación y con su IGV, en estado *Emitida*.\n3. Los servicios que cubre quedan marcados como facturados, así que **dejan de aparecer para liquidar** y su margen ya se considera cerrado en /gastos.\n\n**Sé consciente de esto:** hoy el ERP **no te bloquea** si el cliente todavía no dio su conformidad. El botón funciona igual. La disciplina de esperar el visto bueno es tuya — y vale la pena, porque después de facturar la única corrección posible es una nota de crédito.",
      },
      {
        pregunta: "¿Y cuando pulso “→ CxP” en una liquidación de proveedor?",
        respuesta:
          "La liquidación pasa a **por pagar** y **se crea la factura de compra** correspondiente en Tesorería → Cuentas por pagar, con su subtotal, su IGV y su detracción.\n\nDe ahí en adelante sigue el circuito normal de una cuenta por pagar: gerencia la aprueba, entra a un lote de pago, se paga y se deposita la detracción.\n\nUn detalle que conviene saber: **el total del comprobante que se crea es el bruto** (subtotal + IGV), no el neto que le vas a transferir. La detracción y los adelantos son mecanismos de pago, no descuentos del comprobante — si se registrara el neto, tu registro de compras quedaría subvaluado.",
      },
      {
        pregunta: "¿Por qué la ida y el retorno cuentan como un solo servicio?",
        respuesta:
          "Porque así es como se factura en transporte de personal: el precio pactado cubre el traslado completo (llevar y traer), no cada tramo por separado.\n\nEl ERP los empareja solo y te lo indica en el rótulo del grupo (“…servicio(s) (ida y retorno)”). Si contara los dos tramos, estarías facturando el doble.",
      },
      {
        pregunta: "El cliente canceló la ida pero el retorno sí se hizo. ¿Cómo lo cobro?",
        respuesta:
          "**Ponle el precio al retorno**, que es el tramo donde hubo servicio, y deja la ida cancelada en S/ 0.00. El día se liquida igual: el ERP cobra un día cuando se prestó **cualquiera** de sus dos tramos, no solo el que suele llevar la tarifa.\n\nSi el precio se quedó cargado en la ida cancelada, el día **también** se cobra —no se pierde—, pero la pantalla de cierre te avisa: *«el importe está en la ida, que no se prestó»*. Ese aviso está para que decidas si corresponde cobrar el día completo o ajustar el importe a lo que realmente se hizo.\n\nEn el Anexo 1 el cliente ve el detalle del día: el tramo prestado como **Conforme** y el caído como **No ejecutado**. No hay nada que esconder ahí — al contrario, es lo que sustenta el cobro.",
      },
      {
        pregunta: "¿Por qué el retorno sale en S/ 0.00 y me avisaba que “no se podrá liquidar”?",
        respuesta:
          "El S/ 0.00 del retorno es **correcto**: AFA cobra una sola tarifa por los dos tramos del día, y esa tarifa vive en un solo servicio (normalmente la ida). El retorno viaja incluido.\n\nEse aviso miraba cada servicio por separado, sin saber que tenía par, así que salía en **todos** los retornos. Ya no: ahora el formulario de Programación te muestra el otro tramo con su importe y solo avisa cuando de verdad hay algo mal — que **ninguno** de los dos tenga importe, o que lo tengan **los dos**.\n\nLo de «los dos» es lo caro: si cargas la tarifa en la ida y en el retorno, el cierre lo liquida como **dos servicios** y el día se cobra dos veces. Por eso ahora se pide confirmación expresa antes de guardarlo así, y en la lista de Programación el día sale marcado **DÍA 2×**.",
      },
      {
        pregunta: "¿De dónde sale el texto de cada ítem de la valorización?",
        respuesta:
          "Del **nombre completo de la ruta**, tal como lo escribió la operación, y de nada más:\n\n**TRANSPORTE DE PERSONAL · 15 PAX · DEL 01-08-2026 AL 31-08-2026**\n**IDA ·** RUTA A/ ENTRADA 06:35/ SANTA ANITA→BSF PUNTA HERMOSA\n**RETORNO ·** RUTA A/ RETORNO 17:00/ BSF PUNTA HERMOSA→SANTA ANITA (incluido en la misma tarifa)\n\nSe imprimen **los dos tramos** aunque la tarifa esté cargada en uno solo. Eso es a propósito: la ida y el retorno tienen dos nombres independientes, y si no se vieran los dos, un ítem podría salir rotulado con la ruta equivocada sin que nadie lo notara.\n\nDos servicios van al mismo ítem cuando coinciden **la ida, el retorno y la tarifa** — o sea, cuando son la misma ruta contratada. Por eso el nombre de ruta no es decorativo: si a mitad de mes alguien lo reescribe, esa ruta sale partida en dos renglones.\n\nSi el documento es anterior a este formato, ábrelo con **✎ Revisar** y pulsa **↻ Recalcular descripciones**: reescribe el texto con los datos de hoy sin tocar cantidades, precios ni totales. Solo funciona en borrador.",
      },
      {
        pregunta: "¿De dónde sale el “15 PAX”? A veces no aparece.",
        respuesta:
          "De la **capacidad contratada**, que es lo que el cliente pidió — no la del bus que salió ese día.\n\nLa distinción importa: si el cliente contrató 15 asientos y AFA, por disponibilidad, manda un lunes uno de 17, un martes uno de 20 y un jueves uno de 16, el formato tiene que seguir diciendo **15**. Antes decía el número del bus, y ese es un dato con el que se puede observar una factura.\n\nEl ERP lo busca en este orden: lo que corregiste a mano en la línea → lo que el servicio trae de cuando se programó → el ítem de la cotización → la ficha de la ruta. **Si ninguno lo sabe, el ítem sale sin el “N PAX”**, a propósito: mejor un dato de menos que uno inventado.\n\nPara cargarlo, en “Cerrar periodo” tienes el botón **Rutas contratadas** (se pone ámbar y te dice cuántas rutas están sin capacidad). Se llena una vez por ruta y desde el mes siguiente sale solo.",
      },
      {
        pregunta: "¿Cuándo aparece “MÓVIL 1 DE 2” en un ítem?",
        respuesta:
          "**Solo cuando la ruta sale de verdad con dos unidades a la misma hora**, porque una sola no da abasto. Ahí el cliente contrató dos móviles y el formato los lista por separado, como en el Excel que ya firma.\n\nNo aparece por que roten las placas: si en 30 días de servicio pasaron cinco unidades distintas por la misma ruta, sigue siendo **un solo ítem** con 30 servicios. Las placas se listan en el detalle y en el Anexo 1, que es donde son un hecho comprobable — nunca parten la línea.\n\nTampoco aparece cuando el mismo bus da dos vueltas el mismo día a distinta hora: eso son dos servicios de un móvil, no dos móviles.",
      },
      {
        pregunta: "Arriba hay una casilla que dice “Los precios del ERP ya incluyen IGV”. ¿La marco o no?",
        respuesta:
          "Depende de cómo tengas cargados tus precios en Programación, y cambia el resultado:\n\n• **Marcada** — el precio de S/ 1,120 que tienes cargado ya trae el IGV dentro. El ERP lo separa: S/ 949.15 de base + S/ 170.85 de IGV.\n• **Sin marcar** — S/ 1,120 es la base, y el IGV se suma encima: el total sería S/ 1,321.60.\n\nElige mal y toda la liquidación sale con un 18 % de diferencia. **Confirma con tu contador o con quien carga los precios** cómo están registrados, y no lo cambies de mes a mes.",
      },
      {
        pregunta: "Me equivoqué en una liquidación que ya emití. ¿Cómo la corrijo?",
        respuesta:
          "Depende de hasta dónde llegó:\n\n• Si está **emitida u observada**, usa **↩ Reabrir** para volverla a borrador, corrígela con **✎ Revisar** y vuelve a emitirla.\n• Mientras **no haya generado todavía la factura de venta (ni la cuenta por pagar)**, el botón **🗑** te deja anularla y los servicios vuelven a quedar disponibles para liquidar. En cuanto genera el comprobante, ese botón desaparece.\n• Si ya generó la factura al cliente, la corrección ya no es aquí: se hace **emitiendo una nota de crédito** en /facturacion. Una factura emitida no se edita.",
      },
      {
        pregunta: "Son diez clientes y cuatrocientos servicios en la misma pantalla. ¿Cómo trabajo con uno solo?",
        respuesta:
          "Con el desplegable que está al lado de las fechas. Dice **Cliente** en la pestaña de facturar y **Proveedor** en la de pagar, y filtra toda la pantalla de una vez: los grupos, el bloque rojo de “No entran a la liquidación”, los botones de precios y costos faltantes, las rutas sin capacidad contratada y también los documentos ya emitidos.\n\nEn el bloque rojo puedes además pulsar directamente el nombre del cliente de una fila para aislarlo.\n\nCada opción trae dos cifras, y **no son del mismo alcance**:\n\n• **“· 65 serv.”** son los servicios de ese cliente **en el periodo** que tienes puesto. Cuentan por día: la ida y el retorno del mismo día son **un** servicio, igual que en la valorización.\n• **“· 2 doc. emitido(s)”** son las liquidaciones que lleva emitidas **en total**, no las del periodo. Por eso un cliente que ya cerró meses anteriores aparece en la lista aunque este mes no tenga nada: es lo que te deja filtrar sus documentos viejos.\n\nDos detalles más que conviene saber:\n\n• **Filtrar es mirar, no desmarcar.** Si ya habías marcado grupos de otro cliente, siguen marcados y el botón verde los va a liquidar igual. Por eso la barra te avisa entre paréntesis cuántos seleccionados quedaron **fuera del filtro**.\n• El filtro **se limpia solo** al cambiar de pestaña, porque los clientes y los proveedores son listas distintas. Y si **mueves las fechas**, se borra la selección de grupos: lo marcado era del periodo anterior.",
      },
      {
        pregunta: "¿Qué es el botón “Del 15 al 14”?",
        respuesta:
          "Un atajo de periodo. Varios clientes corporativos de AFA no cierran de fin de mes a fin de mes, sino **del día 15 al 14 del mes siguiente**. El botón te pone ese rango de una vez.\n\nAl lado tienes “Mes pasado” para el cierre mensual normal. También puedes poner las dos fechas a mano.",
      },
      {
        pregunta: "Un grupo me avisa de que no tiene sede. ¿Importa?",
        respuesta:
          "Sí. La **sede** es la que aporta el área solicitante y la persona que aprueba en el cliente. Sin ella:\n• el formato sale sin esos datos, con lo cual el cliente puede rebotarlo, y\n• **no hay a quién mandarle la conformidad**.\n\nEl botón “+ Crear sede” del propio grupo te deja cargarla ahí mismo, sin salir de la pantalla.",
      },
    ],
    comoHacer: [
      {
        titulo: "Cerrar el periodo del cliente y mandar la conformidad",
        pasos: [
          "Entra a Liquidaciones, pestaña “Al Cliente (facturar)” y vista “Cerrar periodo”.",
          "Fija el periodo: “Mes pasado” o “Del 15 al 14”, según cómo cierre ese cliente.",
          "Si vas a cerrar cliente por cliente, elígelo en el desplegable “Cliente” que está junto a las fechas: la pantalla entera se queda solo con lo suyo.",
          "Revisa los grupos. Abre los que estén en rojo y corrige en Programación lo que dice el bloque “No se pueden liquidar todavía”.",
          "Comprueba que cada grupo tenga sede. Si no la tiene, pulsa “+ Crear sede” y cárgala.",
          "Verifica arriba la casilla “Los precios del ERP ya incluyen IGV” — que esté como corresponde a cómo cargas tus precios.",
          "Marca las casillas de los grupos que vas a liquidar. La barra de arriba te dice cuántos van y por cuánto.",
          "Pulsa “Liquidar N grupo(s)”. Se genera un documento por grupo.",
          "Cambia a la vista “Documentos”. Revisa cada uno con “✎ Revisar” y ábrelo con “📄 PDF” para ver cómo lo va a recibir el cliente.",
          "Pulsa “✉ Enviar” para mandarle el enlace de conformidad al cliente. En la columna Conformidad verás cómo pasa de pendiente a conforme (u observada).",
          "Cuando el cliente dé su conformidad, pulsa el botón verde “Facturar” de esa fila: ahí se genera la factura de venta.",
        ],
        advertencia:
          "No apruebes antes de la conformidad si el cliente es de los que revisa. Corregir después significa nota de crédito, factura nueva y un mes más de espera para cobrar.",
      },
      {
        titulo: "Cerrar el periodo de un proveedor tercerizado",
        pasos: [
          "Cambia a la pestaña “Al Proveedor (pagar)”, misma vista “Cerrar periodo”.",
          "Fija el mismo periodo que usaste para el cliente, para que los dos lados cuadren.",
          "Los grupos ahora son por empresa tercerizada (GRIJALVA TOURS, ALVAREZ FARFAN…). Con el desplegable “Proveedor” te quedas con uno solo si vas a cerrar de a uno.",
          "Ábrelos y revisa las líneas al costo pactado.",
          "Marca los grupos correctos y pulsa “Liquidar N grupo(s)”.",
          "En la vista “Documentos”, revisa el detalle con “✎ Revisar” y mándaselo al proveedor con “✉ Enviar” para que coteje antes de emitirte su factura.",
          "Cuando esté conforme, pulsa el botón verde “→ CxP” de esa fila: se crea la cuenta por pagar en Tesorería.",
          "El resto del camino sigue en Tesorería: aprobación de gerencia, lote de pago y depósito de la detracción.",
        ],
        advertencia:
          "Si el proveedor te emite una factura por un monto distinto al de la liquidación, no cambies la liquidación para que “cuadre”: averigua de dónde sale la diferencia. Casi siempre es un servicio que él cuenta y tú no, o al revés.",
      },
    ],
    relacionadas: [
      { etiqueta: "Facturación · la factura que nace de aquí", href: "/facturacion" },
      { etiqueta: "Tesorería · la cuenta por pagar que nace de aquí", href: "/tesoreria" },
      { etiqueta: "Empresas tercerizadas · quién ejecutó el servicio", href: "/tercerizadas" },
      { etiqueta: "Gastos · el margen real del periodo", href: "/gastos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PROVEEDORES Y TERCERIZADAS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "proveedores",
    rutas: ["/proveedores", "/tercerizadas"],
    titulo: "Proveedores y empresas tercerizadas",
    resumen:
      "El padrón de a quién le compras: talleres, grifos, aseguradoras y repuesteros por un lado (Proveedores), y las empresas de transporte que ponen unidades a tu nombre por el otro (Empresas Tercerizadas), con su flota, sus choferes y sus documentos.",
    paraQueSirve: [
      "Tener en un solo sitio a quién le compras, con su RUC, su rubro y su contacto.",
      "No volver a escribir el RUC ni buscar el nombre exacto cada vez que registras una factura.",
      "Controlar que las unidades y los choferes de un tercerizado tengan sus documentos vigentes.",
      "Bloquear a un proveedor con el que ya no quieres trabajar sin perder su historial.",
    ],
    conceptos: ["ruc", "cci", "tercerizado", "cuentas_por_pagar", "lote_pago", "comprobante"],
    faqs: [
      {
        pregunta: "¿Qué diferencia hay entre Proveedores y Empresas Tercerizadas?",
        respuesta:
          "• **Proveedores** — a quien le compras **bienes y servicios de apoyo**: el taller, el grifo, la vulcanizadora, el seguro, la financiera del leasing, el lavadero. Te venden algo y te facturan.\n\n• **Empresas Tercerizadas** — empresas de transporte que **ejecutan servicios en nombre de AFA**. Ponen la unidad y el chofer, y el cliente ve un servicio de AFA. Por eso su ficha lleva mucho más: la flota con sus placas, los conductores con sus licencias y los documentos (autorización MTC, habilitación SUTRAN) con sus vencimientos.\n\nSi la SUTRAN para una unidad tercerizada con la habilitación vencida, el problema es de AFA, no del tercero. Por eso ese control vive aquí.",
      },
      {
        pregunta: "Quiero pagarle a un proveedor por el archivo del banco. ¿Dónde pongo su cuenta y su CCI?",
        respuesta:
          "**Hoy se ponen en la factura, no en esta ficha.** El alta de proveedor pide razón social, RUC, rubro, teléfono, correo, dirección y contacto — pero todavía no tiene campos bancarios.\n\nLos datos de abono se escriben al registrar el comprobante: Tesorería → 🧾 Cuentas por pagar → **+ Registrar factura** (o **Editar** en una que ya existe), en los campos **Titular de la cuenta**, **Banco**, **Número de cuenta** y **CCI** de la parte de arriba.\n\nPor qué importa: **sin cuenta ni CCI esa obligación no puede entrar a un lote de pago**. Al armar el lote sale en amarillo con el aviso “Sin cuenta ni CCI del beneficiario” y la casilla queda bloqueada.\n\nLa diferencia entre los dos números:\n• **Número de cuenta** — sirve para transferir dentro del mismo banco.\n• **CCI** (20 dígitos) — el código interbancario, sirve para transferir desde cualquier otro banco.",
      },
      {
        pregunta: "El titular de la cuenta no se llama igual que la empresa. ¿Está mal?",
        respuesta:
          "No necesariamente, y en transporte pasa constantemente: muchos transportistas facturan con su razón social pero cobran a nombre del dueño de la unidad.\n\nPor eso, en el modal de la factura de compra, **“Titular de la cuenta” es un campo aparte** de la razón social. Pon el nombre exactamente como figura en la cuenta bancaria: es lo que va al archivo del banco y es lo que aparece como beneficiario en el lote. Si no coincide, el abono se rechaza y esa línea vuelve a quedarte impaga.",
      },
      {
        pregunta: "Registré dos veces el mismo proveedor. ¿Qué hago?",
        respuesta:
          "Antes de crear uno nuevo, búscalo siempre por RUC en el buscador: es la forma segura de no duplicar.\n\nSi ya tienes el duplicado, deja activo el que tiene las facturas asociadas y **desactiva el otro** (estado Inactivo) en vez de borrarlo. Borrarlo puede dejar comprobantes huérfanos.\n\nEl ERP tiene una defensa por el otro lado: no deja registrar dos veces la misma factura para el mismo RUC con la misma serie y número.",
      },
      {
        pregunta: "¿Para qué sirven los avisos de documentos vencidos de una tercerizada?",
        respuesta:
          "Para que no salga a la calle una unidad que no puede circular. En la ficha de cada empresa, la pestaña **📄 Documentos** lleva el control de la autorización del MTC, la habilitación de la SUTRAN y demás, con su fecha de vencimiento.\n\nCuando algo está vencido o por vencer, la ficha te lo marca arriba con un enlace directo a la lista filtrada. Es un control operativo, pero tiene consecuencias de dinero: una unidad intervenida es un servicio no prestado, una multa, y un cliente molesto.",
      },
      {
        pregunta: "Puse un proveedor en “Bloqueado”. ¿Qué cambia?",
        respuesta:
          "Es una marca de gestión: le estás diciendo a tu equipo que con ese proveedor no se trabaja más (cobra de más, no cumple, tuvo un problema serio).\n\nNo borra nada ni deshace facturas ya registradas: su historial se conserva completo. Usa **Inactivo** para uno con el que simplemente dejaste de operar, y **Bloqueado** cuando quieres que quede claro que fue una decisión.",
      },
    ],
    comoHacer: [
      {
        titulo: "Dar de alta un proveedor",
        pasos: [
          "Busca primero por RUC en el buscador para no duplicar.",
          "Pulsa “+ Nuevo proveedor”.",
          "Elige el tipo en la fila de botones (Taller mecánico, Grifo / combustible, Repuestos, Seguros / broker, Leasing / financiera, Neumáticos…): es lo que después te deja filtrar el gasto por rubro.",
          "Pon el “Nombre / Razón social” tal como figura en sus facturas y su RUC (11 dígitos).",
          "Carga teléfono, email, dirección y, abajo, el nombre y el celular de la persona de contacto.",
          "Deja el Estado en “Activo” y pulsa “Guardar proveedor”. Cuando registres su primera factura en Tesorería, lo encontrarás escribiendo su nombre o su RUC.",
        ],
        advertencia:
          "Las empresas de transporte que ponen unidades a tu nombre NO van aquí: van en Tercerizadas. Esta pantalla excluye a propósito ese rubro para que no aparezcan en los dos sitios.",
      },
      {
        titulo: "Dar de alta una empresa tercerizada con su flota",
        pasos: [
          "En /tercerizadas pulsa “+ Nueva empresa” y carga razón social, RUC, contacto y la dirección de la cochera.",
          "Selecciona la empresa en la lista de la izquierda para abrir su ficha.",
          "Pestaña 🚌 Flota: agrega cada unidad con su placa (por ejemplo CWQ-400), categoría, capacidad de pasajeros y fotos.",
          "Pestaña 👤 Conductores: agrega los choferes que esa empresa asigna a los servicios de AFA.",
          "Pestaña 📄 Documentos: carga la autorización MTC, la habilitación SUTRAN y demás, con sus fechas de vencimiento.",
        ],
        advertencia:
          "Carga las fechas de vencimiento aunque el documento esté al día. Sin fecha, el ERP no te puede avisar cuando esté por caducar, y esa es la mitad del valor de tener el módulo.",
      },
    ],
    relacionadas: [
      { etiqueta: "Tesorería · sus facturas y sus pagos", href: "/tesoreria" },
      { etiqueta: "Órdenes de compra · lo que les pides", href: "/ordenes-compra" },
      { etiqueta: "Liquidaciones · cerrar el mes con el tercerizado", href: "/liquidaciones" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ÓRDENES DE COMPRA
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "ordenes-compra",
    rutas: ["/ordenes-compra"],
    titulo: "Órdenes de compra · autorizar antes de comprar",
    resumen:
      "La orden de compra es el documento que le mandas al proveedor ANTES de comprar: esto quiero, a este precio, para esta fecha. Sirve para que nadie compre por su cuenta y para que después la factura que llega coincida con lo pactado.",
    paraQueSirve: [
      "Autorizar una compra antes de que se haga, no cuando llega la factura.",
      "Dejar por escrito precio, cantidad y plazo de entrega con el proveedor.",
      "Cotejar después la factura contra lo que se pidió.",
      "Saber qué está pedido y todavía no ha llegado.",
    ],
    conceptos: ["comprobante", "estado_aprobacion", "igv", "cuentas_por_pagar", "vencimiento"],
    faqs: [
      {
        pregunta: "¿Qué es una orden de compra y cuándo la uso?",
        respuesta:
          "Es **tu pedido formal al proveedor, antes de comprar**: tantas unidades de esto, a este precio, entregado tal fecha, con esta condición de pago.\n\nÚsala cuando la compra vale la pena controlarla: un juego de neumáticos, un repuesto caro, la póliza del seguro, un servicio de taller programado. Para comprar un galón de aceite un domingo, no.\n\nLo que te da a cambio: cuando llega la factura del proveedor, tienes contra qué compararla. Sin orden de compra, todo lo que puedes hacer es creerle al monto que te facturaron.",
      },
      {
        pregunta: "¿Cuál es el recorrido de estados?",
        respuesta:
          "**Borrador → Pend. aprobación → Aprobada → Enviada → Recibida (o Recibida parcial)**\n\n• **Borrador** — la estás armando, todavía no la ve nadie.\n• **Pend. aprobación** — esperando el visto bueno.\n• **Aprobada** — autorizada internamente.\n• **Enviada** — ya se la mandaste al proveedor.\n• **Recibida parcial** — llegó una parte del pedido.\n• **Recibida** — llegó todo.\n• **Anulada** — se cayó la compra. Pide motivo.\n\nEl botón 🖨️ te genera el documento imprimible para mandárselo al proveedor.",
      },
      {
        pregunta: "¿La orden de compra es una cuenta por pagar? ¿Ya le debo esa plata?",
        respuesta:
          "**No.** Una orden de compra es una intención: dice lo que vas a comprar, no lo que ya debes.\n\nLa deuda nace **cuando el proveedor te emite la factura**, y esa factura se registra en Tesorería → Cuentas por pagar. Hasta entonces, si se cae el pedido, lo anulas y no debes nada.\n\nPor eso las órdenes no aparecen en la deuda de Tesorería ni en el lote de pago: no son un comprobante, son un compromiso.",
      },
      {
        pregunta: "Pulsé “💸 Registrar como gasto”. ¿Eso significa que ya está pagada?",
        respuesta:
          "No necesariamente. Lo que hace es **crear el gasto en /gastos** por el total de la orden, con su proveedor y su vehículo, para que el costo aparezca donde tiene que aparecer.\n\nEl estado del gasto lo pone según la condición de pago que le pusiste a la orden:\n• Condición **Contado** → el gasto nace **Pagado**.\n• Cualquier crédito → el gasto nace **Pendiente**.\n\nSi era a crédito, la plata todavía no salió: cuando llegue la factura del proveedor, regístrala en Tesorería y págala por el circuito normal.\n\nEl botón solo funciona una vez por orden: no puede duplicar el gasto.",
      },
      {
        pregunta: "El total de mi orden no coincide con la factura que me llegó. ¿Por qué?",
        respuesta:
          "La causa más común es el **IGV**, y conviene entender bien cómo funciona la casilla porque su nombre despista.\n\nLos precios unitarios que escribes en los ítems son **siempre la base, sin IGV**. La casilla **“Incluye IGV”** decide si el ERP le **suma** el 18 % encima:\n• **Marcada** → ítems por S/ 1,000 dan un total de S/ 1,180 (subtotal 1,000 + IGV 180).\n• **Sin marcar** → el total es S/ 1,000 y el documento impreso dice “No incluye IGV”.\n\nSi la dejaste al revés, la orden y la factura te van a bailar exactamente un 18 %.\n\nLas otras causas típicas: el proveedor cambió el precio unitario, o entregó una cantidad distinta de la pedida (revisa si la orden está en “Recibida parcial”).\n\n**No fuerces la orden para que cuadre con la factura.** La orden es lo que pactaste; si la factura no coincide, esa es justamente la conversación que hay que tener con el proveedor. Para eso existe el documento.",
      },
    ],
    comoHacer: [
      {
        titulo: "Emitir una orden de compra y aprobarla",
        pasos: [
          "Pulsa “+ Nueva orden”.",
          "Elige el proveedor y la categoría (Taller mecánico, Grifo / combustible, Repuestos, Neumáticos, Seguros / broker…). Si la compra es para una unidad concreta, elige la placa (CWQ-400).",
          "Pon la fecha de entrega esperada y la condición de pago (Contado, Crédito 15 días, Crédito 30 días, Detracción, Otro).",
          "En “IGV (18%)” decide la casilla “Incluye IGV”: márcala si al total hay que sumarle el 18 %; déjala sin marcar si la compra no lleva IGV. Los precios que escribas abajo son siempre la base.",
          "Agrega los ítems con “+ Agregar ítem”: descripción, cantidad, unidad y precio unitario. El subtotal, el IGV y el total se calculan solos.",
          "Guarda. Nace en Borrador.",
          "Abre la orden (pulsando su fila) y pulsa “Enviar a aprobación”, y luego “Aprobar” cuando tenga el visto bueno.",
          "Pulsa 🖨️ para generar el documento imprimible y mándaselo al proveedor. Luego pulsa “Marcar enviada”.",
        ],
        advertencia:
          "Decide bien la casilla “Incluye IGV” antes de mandar la orden. Es el error que después hace que la orden y la factura del proveedor bailen un 18 % y nadie sepa por qué.",
      },
      {
        titulo: "Recibir la mercadería y dejar el costo registrado",
        pasos: [
          "Cuando llegue el pedido, abre la orden y pulsa “Marcar recibida” (o “Recepción parcial” si llegó solo una parte).",
          "Pulsa “💸 Registrar como gasto” para que el costo entre a /gastos con su proveedor y su vehículo.",
          "Cuando el proveedor te emita la factura, regístrala en Tesorería → Cuentas por pagar y compárala contra esta orden: cantidades, precios unitarios y total.",
          "Si coincide, sigue el circuito normal: aprobación de gerencia, lote de pago.",
        ],
        advertencia:
          "No registres como gasto una orden que todavía no recibiste. Si el pedido nunca llega, quedaste con un costo en los libros que no existe.",
      },
    ],
    relacionadas: [
      { etiqueta: "Proveedores · a quién le compras", href: "/proveedores" },
      { etiqueta: "Gastos · dónde aterriza el costo", href: "/gastos" },
      { etiqueta: "Tesorería · la factura que llega después", href: "/tesoreria" },
    ],
  },

  {
    clave: "pactos",
    rutas: ["/pactos"],
    titulo: "Pactos · lo que se acordó, y todo lo que cambió después",
    resumen:
      "Aquí se ve lo que se acordó pagarle a cada proveedor y cobrarle a cada cliente por un servicio, qué servicios nadie pactó todavía, y cada cambio que ocurrió después de la cotización: quién lo hizo, cuándo y por qué.",
    paraQueSirve: [
      "Encontrar HOY los servicios tercerizados sin costo pactado, en vez de descubrirlos al cerrar el mes.",
      "Cargar esos costos en lote, agrupados por proveedor y ruta, con el importe que ya está en tus facturas de compra.",
      "Que gerencia autorice solo los cambios que de verdad bajan el margen, y no todos.",
      "Responder “¿quién le cambió el proveedor a este servicio y por qué?” sin llamar a nadie.",
      "Imprimir la adenda de un contrato: el sustento de por qué el mes salió distinto de lo cotizado.",
    ],
    conceptos: [
      "pacto_servicio",
      "costo_real_comparable",
      "afectacion_igv",
      "visado_gerencia",
      "adenda",
      "tercerizado",
      "margen_real",
      "regla_oro",
    ],
    faqs: [
      {
        pregunta: "¿Por qué aparecen menos servicios acá que líneas rojas en Liquidaciones?",
        respuesta:
          "Porque esta pantalla cuenta **decisiones**, no líneas.\n\nUn servicio de ida y vuelta son dos filas en la base, pero la tarifa va en una sola: el retorno se cobra dentro de la ida. Cuando las dos están en cero, Liquidaciones marca las dos en rojo —y con razón, porque no puede saber cuál llevará el importe—. Acá, en cambio, se muestra **una sola**: en cuanto pactas la ida, el retorno pasa solo a “incluido” y desaparece.\n\nPor eso 67 líneas rojas suelen ser unas 30 decisiones de verdad. El número de acá es el que te dice cuánto trabajo real tienes por delante.",
      },
      {
        pregunta: "¿Esto va a impedir que mis operadores despachen?",
        respuesta:
          "**No. Nunca.**\n\nEl servicio se guarda igual, el estado avanza igual, el conductor recibe su aviso igual y el bus sale igual. Si el costo va vacío, el sistema advierte lo que va a pasar y deja guardar de todos modos.\n\nLa decisión de diseño es esa a propósito: una regla que impide despachar a las 5 de la mañana se esquiva el primer día y termina odiada. Lo que sí se puede frenar —y solo cuando tú lo decidas, en una fase posterior— es **el pago al proveedor** cuando el sobrecosto quedó sin visto bueno. Se congela la plata, no el bus.",
      },
      {
        pregunta: "¿Por qué un proveedor de S/ 550 aparece como más barato que uno de S/ 500?",
        respuesta:
          "Porque no siempre pagas IGV, y **el IGV que sí pagas te lo devuelven** como crédito fiscal.\n\n• Un bus **gravado** que te factura S/ 550: el IGV vuelve, así que te cuesta **S/ 466.10**.\n• Un taxi **exonerado** de S/ 500: no hay IGV que recuperar, te cuesta **S/ 500.00**.\n\nEl “caro” es 7 % más barato. Al revés es peor: un exonerado de S/ 550 contra un gravado de S/ 500 no es 10 % más caro, es **30 %**.\n\nTodas las cifras de esta pantalla y el panel de margen de Programación ya vienen con esa cuenta hecha. El número que ves es el bueno.",
      },
      {
        pregunta: "¿Qué llega a “Por visar” y qué no?",
        respuesta:
          "Solo lo que **empeora el margen más allá de lo tolerado**. Con la política por defecto (+10 % o +S/ 100, margen mínimo 15 %):\n\n• Cargar por primera vez un costo que faltaba → **no** pide visado. Es un dato que se debía, no un deterioro.\n• Cambiar de S/ 500 a S/ 550 → **no** pide visado. Está dentro de la tolerancia.\n• Cambiar de S/ 550 a S/ 950 → **sí**.\n• Conseguir un proveedor más barato → **nunca** pide visado.\n\nEso último es deliberado: si el cambio bueno costara el mismo trámite que el malo, el operador aprende a esconder los dos.",
      },
      {
        pregunta: "¿Qué significa “Cuenta de control: cuadrado”?",
        respuesta:
          "Que **el acta y la realidad dicen lo mismo**: para cada servicio, el importe que figura en su ficha coincide con el último importe registrado en su historial.\n\nEs el semáforo más importante de la pantalla y el que menos se mira. Si alguna vez muestra un número en vez de “Cuadrado”, significa que alguien escribió un importe por un camino que no dejó rastro, y hay que encontrarlo antes de endurecer ninguna regla.",
      },
      {
        pregunta: "¿Qué son las “actas de apertura” que no se muestran?",
        respuesta:
          "Son la **foto del día en que se instaló el Pacto**: una por cada servicio vivo, con el importe que tenía en ese momento y **sin autor**.\n\nNo se inventaron autores para el pasado: antes de esto el ERP no guardaba ningún historial, así que firmar por lo que pasó antes sería mentir. La línea de corte queda explícita — de ahí para atrás nadie firma, de ahí para adelante todo tiene nombre, fecha y motivo. Ningún reporte histórico cambió de valor por esto.",
      },
    ],
    comoHacer: [
      {
        titulo: "Cargar de una vez los costos que faltan del mes",
        pasos: [
          "Entra a la pestaña “Sin costo pactado”. Arriba se ve cuántas decisiones reales hay.",
          "Empieza por los grupos marcados “Ya ejecutado”: ahí el proveedor ya trabajó y está esperando su plata.",
          "En cada grupo (proveedor + ruta) usa “Pactar”. Si el importe ya está en una factura de compra tuya, aparece propuesto: acéptalo con un clic.",
          "Si no hay propuesta, escribe el importe una vez en “Aplicar a todo el grupo” y se reparte a los servicios de ese grupo.",
          "Revisa que el IGV del grupo sea el correcto (gravado para un bus, exonerado para un taxi) y guarda.",
        ],
        advertencia:
          "Cuando una misma factura calza con varios servicios, el sistema NO propone importe para ninguno: esa factura dice el total de todos juntos, no el costo de cada uno. Ahí decide una persona mirando el detalle.",
      },
      {
        titulo: "Autorizar o rechazar los cambios pendientes",
        pasos: [
          "Entra a “Por visar”. Arriba se ve el impacto acumulado en soles de lo que está sin autorizar.",
          "Prioriza los marcados “Vencido” y los de “Margen negativo”.",
          "Lee el antes → después y el motivo que declaró quien hizo el cambio.",
          "Marca varios y aprueba en bloque, o rechaza uno explicando por qué (el motivo queda en el acta y lo lee quien hizo el cambio).",
        ],
        advertencia:
          "Aprobar o rechazar es solo para administración y gerencia. Rechazar no deshace nada —el servicio ya se prestó—: deja constancia de que ese sobrecosto no estaba autorizado.",
      },
      {
        titulo: "Sustentarle a un cliente por qué el mes salió distinto",
        pasos: [
          "Entra a “Historial” y quédate en la vista “Por contrato”.",
          "Busca la cotización del cliente: verás cuántos servicios cambiaron, cuánto subió la venta, cuánto el costo y cómo quedó el margen.",
          "Para el detalle servicio por servicio, cambia a “Movimientos” y busca por el número de la ruta o del contrato.",
        ],
      },
    ],
    relacionadas: [
      { etiqueta: "Programación · donde se pacta el cambio", href: "/programacion" },
      { etiqueta: "Liquidaciones · el cierre del periodo", href: "/liquidaciones" },
      { etiqueta: "Tercerizadas · los proveedores y sus unidades", href: "/tercerizadas" },
    ],
  },
];
