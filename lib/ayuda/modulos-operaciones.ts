// ──────────────────────────────────────────────────────────────────────────────
// lib/ayuda/modulos-operaciones.ts — Fichas de ayuda de OPERACIONES y COMERCIAL.
//
// Mismo criterio que las fichas de dinero: se le habla al dueño del negocio, no a
// un programador. Se responde la pregunta que la persona hace de verdad ("¿por qué
// el conductor no ve el servicio?", "¿de dónde sale este número?"), con la pantalla
// abierta al lado, y cuando algo no es fiable se dice con esas palabras.
//
// Dos reglas que estas fichas NO pueden contradecir, porque tienen fuente única:
//   · El ciclo de estados del servicio vive en lib/estados.ts. "En curso" lo activa
//     SOLO el conductor con su check-in por GPS; al finalizar, el ciclo administrativo
//     arranca en "por liquidar".
//   · Los términos contables se referencian por clave contra lib/ayuda/glosario.ts.
//     Aquí no se redefine ninguno.
// ──────────────────────────────────────────────────────────────────────────────

import type { AyudaModulo } from "@/lib/ayuda/tipos";

export const MODULOS_OPERACIONES: AyudaModulo[] = [
  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "dashboard",
    rutas: ["/dashboard"],
    titulo: "Dashboard · cómo está la operación hoy",
    resumen:
      "Es la primera pantalla del día: cuántos servicios hay hoy, qué unidades están listas para salir, qué documento está por vencer y qué alertas hay que atender antes de que se conviertan en un problema.",
    paraQueSirve: [
      "Ver de un vistazo los servicios de hoy, con su placa, su conductor y su estado.",
      "Detectar lo que puede parar un bus: SOAT o revisión técnica vencidos, licencia vencida, neumático al límite, mantenimiento pasado de fecha.",
      "Saber si te falta asignar unidad o conductor a algún servicio del día.",
      "Entrar rápido al módulo donde se arregla cada cosa: cada alerta es un enlace.",
    ],
    conceptos: ["margen", "margen_real", "tercerizado", "estado_admin"],
    faqs: [
      {
        pregunta: "¿De dónde salen los números de esta pantalla?",
        respuesta:
          "De las tablas del propio ERP, leídas en vivo cada vez que abres la página. No hay nada tecleado a mano aquí:\n\n• Los servicios y el margen salen de **Programación** (las reservas).\n• El semáforo de flota y los kilómetros, de **Vehículos** y **Mantenimiento**.\n• Los vencimientos, de **Documentos vehiculares**, **Seguros** y **Conductores**.\n• Los gastos, de la tabla de **Gastos**.\n• Las alertas SOS llegan en tiempo real desde la app del conductor.\n\nSi un número te parece raro, el sitio donde se corrige es el módulo de origen, no el dashboard: aquí solo se muestra.",
      },
      {
        pregunta: "La tarjeta “Finanzas · últimas 12 semanas”, ¿son mis ventas reales?",
        respuesta:
          "**No. Esa curva todavía es un dibujo de ejemplo.** La tarjeta se titula *Ingresos vs. Gastos*, pero las dos líneas están hechas con números fijos que no salen de tu base de datos, y los botones **7d / 4s / 12s / YTD** de esa misma tarjeta todavía no filtran nada. Es honesto decírtelo: no tomes decisiones mirando esa línea.\n\nLos tres números de abajo de la tarjeta (**Ingresos**, **Gastos**, **Margen**) sí son tuyos, pero **no son del mes** aunque el rótulo diga “mes”: son el acumulado de todo lo que hay cargado.\n\nPara cifras de un periodo concreto usa **Finanzas** o **Gastos**, que sí filtran por fecha.",
      },
      {
        pregunta: "Los porcentajes verdes y rojos de las tarjetas de arriba (+12 %, +9.4 %…), ¿de qué mes a qué mes son?",
        respuesta:
          "**De ninguno. Esos porcentajes están escritos a mano en la pantalla y no cambian nunca**, igual que las minicurvas que llevan al lado. Son decoración que quedó de la maqueta.\n\nEl número grande de cada tarjeta sí es real (los servicios, lo facturado, el margen, los gastos). La flechita y el porcentaje de al lado, no. Si esta semana vendiste la mitad, esa flecha va a seguir diciendo “+12 %”.\n\nY hay una tarjeta que además está **mal rotulada**: la que dice **“Cumplimiento SLA”** no mide ningún cumplimiento de plazos — el porcentaje que muestra es tu **margen sobre las ventas**. Léela como margen y no como servicio al cliente.\n\nMientras eso no se corrija, la regla es simple: **fíate del número grande, ignora todo lo que lo acompaña.**",
      },
      {
        pregunta: "¿Por qué “Ingresos” no coincide con lo que facturé?",
        respuesta:
          "Porque son dos cosas distintas y el dashboard las muestra por separado a propósito:\n\n• **Ingresos** = la suma del precio pactado de tus servicios, esté facturado o no. Es lo que vendiste.\n• **Facturado** = la suma de los comprobantes emitidos. Es lo que ya pasó por SUNAT.\n\nEntre uno y otro está justo el trabajo pendiente: servicios hechos que nadie liquidó ni facturó. Esa diferencia es plata tuya que todavía no está en camino — y se persigue desde **Liquidaciones**.\n\nOjo también con la tarjeta **Gastos**: ahí solo entran los gastos generales. El combustible y el mantenimiento van aparte, en el bloque **Desglose de costos**, cada uno en su línea. El total de egresos de verdad está en **Gastos** y en **Finanzas**.",
      },
      {
        pregunta: "¿Qué significa “Riesgo operativo: Alto” y el semáforo verde / amarillo / rojo?",
        respuesta:
          "El **riesgo operativo** es un resumen de las alertas del día: cada alerta **crítica** suma 20 puntos y cada alerta de **atención** suma 5, hasta un tope de 100. Con eso sale la etiqueta: 0 = *Bajo*, hasta 20 = *Moderado*, hasta 50 = *Alto*, más de 50 = *Crítico*. Es un termómetro, no una nota: sirve para saber si hoy hay que apagar un incendio o no.\n\nEl **semáforo de flota** es por unidad:\n• **Verde**: operativa, con kilómetros de sobra hasta su próximo servicio.\n• **Amarillo**: le quedan menos de 1,000 km o tiene un mantenimiento en los próximos 15 días.\n• **Rojo**: no debería salir — está en taller, inactiva, con documento vencido o con el mantenimiento pasado de fecha.\n\nUn bus en rojo con un servicio asignado es el peor escenario: sale igual, y si lo paran la multa y la parada del servicio te cuestan más que el taller.",
      },
    ],
    relacionadas: [
      { etiqueta: "Programación · los servicios", href: "/programacion" },
      { etiqueta: "Seguimiento del día", href: "/seguimiento" },
      { etiqueta: "Finanzas · cifras por periodo", href: "/finanzas" },
      { etiqueta: "Reportes", href: "/reportes" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PROGRAMACIÓN
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "programacion",
    rutas: ["/programacion"],
    titulo: "Programación · el corazón del ERP",
    resumen:
      "Aquí vive cada servicio: a quién se lo haces, qué día, a qué hora, con qué unidad y con qué conductor. Todo lo demás del sistema (la app del conductor, el seguimiento, la liquidación, la factura) cuelga de lo que se registra en esta pantalla.",
    paraQueSirve: [
      "Asignar unidad y conductor a los servicios pendientes, uno por uno o en bloque.",
      "Generar de golpe todos los servicios de un contrato fijo desde una cotización aprobada.",
      "Registrar un servicio ADICIONAL: lo que el cliente pide por encima del contrato, con sus fechas sueltas y su propio precio.",
      "Cargar el manifiesto (los pasajeros y sus paraderos) y mandárselo al conductor y a los pasajeros.",
      "Ver en qué estado está cada servicio y qué le falta para cerrarse administrativamente.",
      "Vigilar el sobrecupo: más pasajeros que asientos.",
      "Etiquetar RUTA, TURNO y MÓVIL (🏷): deciden en qué ítem de la liquidación va cada servicio.",
      "Emitir la CONFIRMACIÓN DE RESERVA en PDF (español o inglés) para mandársela al cliente por WhatsApp.",
    ],
    conceptos: ["estado_admin", "estado_proveedor", "tercerizado", "margen", "liquidacion_cliente", "servicio_adicional"],
    faqs: [
      {
        pregunta: "Abrí la Confirmación de una reserva y sale «Pedido por WhatsApp». ¿Qué es?",
        respuesta:
          "Esa reserva nació de un traslado que el cliente aceptó por WhatsApp con la IA del CRM. Debajo del pago se ve su solicitud y los **comprobantes** que mandó el cliente, con lo que leyó la IA; «👁 Ver» abre el último.\n\nEl comprobante es evidencia, no un cobro: el adelanto se registra solo cuando el dinero ya está en la cuenta. Ver la solicitud exige el módulo CRM; sin él, la pantalla te dice dónde se ve.",
      },
      {
        pregunta: "¿Cómo le mando al cliente la Confirmación de Reserva?",
        respuesta:
          "Botón **Confirmación** en la fila del servicio (o **Confirmación de reserva** dentro del formulario). Se abre una ventana con el pago, lo que falta y las confirmaciones ya emitidas.\n\n**Qué la habilita:**\n• Un **adelanto registrado**. Lo registra **Tesorería o Finanzas** en esa misma ventana cuando el dinero ya está en la cuenta — una captura del cliente no basta. Si el cliente tiene condición de **crédito**, se puede emitir sin adelanto y el papel lo dice.\n• Fecha, hora, recojo, destino, cliente y el **precio de venta** registrados. El ERP no imprime un importe que nadie registró.\n\n**Qué imprime:** cliente, servicio (ida y retorno si los hay), unidad y conductor si ya están asignados — si no, dice que se enviarán después —, precio, adelanto con su fecha, saldo y moneda. El teléfono del conductor solo sale si marcas la casilla. Nunca DNI, licencia ni costos.\n\n**Versiones:** si cambias la hora, la unidad, el conductor o el precio, vuelve a pulsar **Generar**: sale la versión siguiente y dice qué cambió. La anterior queda en el historial. Volver a descargar no crea nada nuevo.\n\n**WhatsApp:** en el celular abre la hoja de compartir con el PDF adjunto; en la computadora descarga el PDF y abre WhatsApp con el mensaje y el número del cliente — adjuntas el archivo tú. El ERP no marca nada como enviado.\n\nNo reemplaza al comprobante de pago, y emitirla no cambia el estado del servicio.",
      },
      {
        pregunta: "¿Qué es el chip azul «🏷 RUTA A · T1 · 50 PAX» y cómo lo pongo?",
        respuesta:
          "Son las **etiquetas del ítem de la liquidación**. Deciden en qué renglón del formato va el servicio: todos los que tienen la misma **RUTA, TURNO y MÓVIL** (y los mismos PAX contratados y tarifa) van en **un solo ítem**, aunque cambie la hora. El turno 1 que sale a las 04:35 una semana y a las 05:00 la siguiente suma en el mismo.\n\n• **RUTA** — «RUTA A», «RUTA B»… Si escribes solo «A», queda «RUTA A».\n• **TURNO** — el turno de trabajo de los pasajeros (1, 2, 3…). Lo decides tú; el ERP no lo deduce del horario.\n• **MÓVIL** — solo cuando salen **dos buses a la vez** en la misma ruta y turno. Si sale uno, se deja vacío.\n• **PAX** — no se escribe: sale solo de los PAX contratados.\n\nTres formas de ponerlas, sin rellenar una por una:\n\n• **Muchos a la vez:** marca las filas (filtra por la ruta y las fechas y usa «Seleccionar todos») → **🏷 Etiquetar ítem**. El ERP propone la RUTA desde el nombre y agrupa los días por hora de salida para que escribas el TURNO una vez por grupo.\n• **Al generar un programa fijo:** el generador trae el bloque «Ítem de la liquidación»: la RUTA ya viene del nombre, escribes el TURNO y los servicios nacen etiquetados (con varios vehículos, cada uno como MÓVIL 1, 2…).\n• **Uno solo:** en el formulario del servicio, bloque «🏷 Ítem de la liquidación». Te muestra la sugerencia del ERP con un clic para usarla.\n\nSe guardan en la ida **y** el retorno del día. No cambian ningún importe.",
      },
      {
        pregunta: "¿Qué significa cada estado y cómo avanza un servicio?",
        respuesta:
          "El servicio recorre siempre el mismo camino, y la barra “Flujo de estados” de arriba te dice cuántos hay en cada paso:\n\n• **Pendiente** — el servicio existe pero no tiene unidad ni conductor.\n• **Programada** — ya le asignaste recurso.\n• **Confirmada** — el cliente confirmó que va.\n• **En curso** — el bus está operando.\n• **Finalizada** — el servicio se realizó.\n• **Cancelada** — no se hizo.\n\n**“En curso” no se pone a mano: lo activa el conductor cuando hace su check-in por GPS desde la app.** Esa es la razón de ser del estado: significa “hay un bus rodando y lo puedo ver en el mapa”. Si lo marcaras tú, dejaría de significar eso y el mapa y el seguimiento empezarían a mentir.\n\nPara cerrar un servicio que el conductor olvidó finalizar sí hay salida: el ERP abre **“Finalizar servicio manualmente”** y te obliga a escribir el motivo. Ese motivo se guarda en las observaciones del servicio, marcado como cierre manual, para que después se sepa que esa hora no la puso el conductor.",
      },
      {
        pregunta: "Cancelé un servicio que ya tenía el costo cargado. ¿Qué pasa con esa plata?",
        respuesta:
          "Ahora el ERP te lo pregunta **en el momento de cancelar**, que es el único en que te acuerdas de si el bus llegó a salir. Te da dos caminos:\n\n• **El bus no salió** — no se paga ni se cobra. El importe se pone en **S/ 0.00**. Es lo que viene marcado por defecto.\n• **El proveedor ya había salido y hay acuerdo** — es un **falso flete**: escribes el avance pactado y **por qué** se le paga. El motivo es obligatorio y sin él no te deja guardar: es la única constancia que va a quedar de que salió dinero por un viaje que no se prestó.\n\nDos detalles que no son casualidad:\n\n• **El monto del avance se escribe de nuevo, no se hereda.** El importe que estaba cargado es el del servicio completo; si se copiara solo, pagarías S/ 664.41 donde el acuerdo eran S/ 120.\n• **Al cliente no se le cobra la cancelación, pase lo que pase.** El acuerdo del avance es entre tú y el proveedor; el cliente no es parte, así que su precio se retira igual.\n\nSi cancelas desde el desplegable de la fila y el servicio tiene importe, el ERP te abre el formulario en vez de cancelarlo de una: esa decisión no cabe en un clic.\n\n**Por qué importa dejarlo en cero:** mientras el importe siga escrito, cuenta como costo en los reportes de margen y en el costo por kilómetro de esa unidad, aunque el cierre no lo pague. O sea, tus números salen mal antes de que nadie abra la liquidación.",
      },
      {
        pregunta: "Cancelé la ida pero el retorno sí se hizo. ¿Se pierde el cobro del día?",
        respuesta:
          "No, y el ERP tiene cuidado especial con este caso.\n\nTú cobras **una tarifa por el día** (ida + retorno), y ese importe vive en **un solo** tramo. Cuando el que se cancela es justo el que lleva la tarifa, borrarlo sería borrar el cobro de un día que sí se trabajó — en silencio y sin que ninguna pantalla lo vuelva a mencionar.\n\nPor eso la pregunta de *“¿qué hacemos con el importe?”* **solo aparece cuando el día entero se cayó**. Si el otro tramo sí se prestó, no se te ofrece poner nada en cero: lo que el ERP te dice es que **muevas el importe al tramo que se ejecutó**, que es donde tiene que estar.\n\nLa regla de fondo: el día se cobra si se prestó **cualquiera** de sus dos tramos.",
      },
      {
        pregunta: "Programé el servicio pero el conductor no lo ve en su app. ¿Qué falta?",
        respuesta:
          "Falta **sincronizar el manifiesto**. Asignar la unidad no envía nada: solo deja el servicio listo.\n\nEn la fila del servicio, la columna **Manifiesto** dice *Sincronizado* (verde) o *Sin enviar* (gris). Abre **Manifiesto**, revisa que estén las paradas y los pasajeros, y pulsa sincronizar. En ese momento pasan tres cosas:\n\n1. El servicio y su itinerario aparecen en la app del conductor.\n2. Se avisa a los pasajeros que tengan correo o teléfono cargado.\n3. Queda registrada la fecha del envío.\n\nDos avisos que te va a dar y conviene no ignorar: si hay **paradas sin coordenadas GPS**, te pregunta antes de seguir, porque esos paraderos no funcionarán en el mapa del conductor; y si cambias la hora de un servicio ya sincronizado, te aparece **“¿Re-notificar a los pasajeros?”**, porque se les informó la hora anterior.\n\nOjo con esa segunda pregunta: si respondes **“Ahora no”**, el servicio vuelve a marcarse como *Sin enviar*. No es un error — es el ERP recordándote que lo que tienen los pasajeros ya no coincide con lo que dice el sistema.",
      },
      {
        pregunta: "¿Qué es el “sobrecupo” que sale en rojo?",
        respuesta:
          "Que en el manifiesto hay **más pasajeros asignados que asientos tiene la unidad**. La fila se pinta de rojo y el contador de arriba te dice cuántos servicios están así.\n\nNo es un detalle administrativo: es gente que se queda en el paradero, y en una fiscalización es una infracción. Se arregla de una de dos formas: quitando pasajeros de ese servicio, o cambiando a una unidad de mayor capacidad.\n\nEl ERP te deja sincronizar igual si insistes — te pide confirmación —, porque a veces sabes algo que el sistema no. Pero queda marcado.",
      },
      {
        pregunta: "¿Dónde pongo los PAX que el cliente contrató? No son los del bus.",
        respuesta:
          "En **PAX contratados por el cliente**, dentro de *Datos del servicio*, pegado a la **Capacidad de la unidad asignada**. Los dos números están juntos a propósito: es justo donde se confunden.\n\n• **PAX contratados** es lo que el cliente pidió — 15 asientos — y es lo que imprime la liquidación.\n• **Capacidad de la unidad** es lo que tiene el bus que salió ese día. Cambia según la disponibilidad y **no se copia sola**: mandar uno de 20 a una ruta contratada para 15 no cambia lo que se factura. Declararle al cliente 20 asientos sobre un contrato de 15 es un número con el que se puede observar una factura.\n\nSi lo dejas vacío, debajo del campo el ERP te dice **de dónde va a salir** (del otro tramo del día, del ítem de la cotización o de la ficha de la ruta), o te avisa en ámbar que no lo sabe ninguna fuente y que el ítem saldrá **sin el “N PAX”**. Vacío no es cero: vacío es “no lo sé”.\n\nY si la unidad que asignaste tiene menos asientos que los contratados, te lo dice. No te bloquea —a las 5 a.m. el bus sale igual— pero es mejor enterarse acá que en el paradero.",
      },
      {
        pregunta: "Corregí los PAX de un servicio. ¿Tengo que repetirlo en los otros 29 días del contrato?",
        respuesta:
          "No. Al guardar pasan dos cosas solas:\n\n1. **Se escribe también en el tramo hermano.** Los asientos son del **día**, no del tramo: el cliente contrató una ruta de N asientos, no una ida de 15 y un retorno de 20. La liquidación imprime uno solo (mira la ida primero), así que dejarlos distintos no representa dos cantidades — hace que una se descarte en silencio.\n2. **Si el servicio es de un contrato, el ERP te ofrece aplicarlo al resto.** En el modal *¿Aplicar a más servicios del contrato?*, en *¿Qué se aplica?*, deja marcada **PAX contratados** (viene con el número que acabas de poner) y pon la asignación en **No tocarla**: así no se toca unidad, conductor, hora ni estado. Ese eje alcanza a las idas **y** a los retornos del rango, sin mirar la hora ni la placa, porque los asientos son del contrato.\n\nDos cosas que NO hace, a propósito: no pisa a los servicios que **ya declaran otra capacidad** (son otro móvil del mismo contrato y la suya es correcta — la casilla te dice cuántos deja fuera y por qué), y no confirma nada: corregir cuántos asientos se contrataron no programa un bus.\n\nSi la ruta se repite mes a mes, lo que conviene es ficharla una sola vez en **Liquidaciones → Rutas contratadas**: desde ahí sale sola sin escribirla en cada servicio.",
      },
      {
        pregunta: "Renegocié la tarifa del contrato. ¿Tengo que abrir los 900 servicios uno por uno?",
        respuesta:
          "No. Abre **cualquiera** de los servicios del contrato y guarda —no hace falta que cambies nada en el formulario—: en el modal *¿Aplicar a más servicios del contrato?* marca **Precio de venta** (lo que cobras al cliente) o **Costo del proveedor** (lo que le pagas al tercerizado) y **escribe ahí el importe nuevo**.\n\n" +
          "Son **casillas sueltas con su propio campo**, así que puedes mover solo la plata sin tocar unidad, conductor, hora ni estado. Antes no se podía: el precio de venta no tenía ningún camino masivo, el costo solo viajaba pegado a *Empresa y unidad* —o sea reescribiéndole además el bus a todo el contrato— y las casillas ni siquiera aparecían si no habías tocado ese campo en el formulario.\n\n" +
          "**El campo arranca vacío, y vacío no es S/ 0.00**: en blanco no se escribe nada. Al lado ves lo que lleva el servicio que tienes abierto, con otra etiqueta y sin ningún botón para copiarlo — un campo ya relleno invita a pulsar Enter sobre todo el contrato.\n\n" +
          "**Nacen apagadas, siempre, y hay que elegir el motivo.** Cobrar de menos se reclama y se corrige; cobrar de más hay que pedir que lo devuelvan, y no vuelve. Cada servicio que cambia de importe deja su acta con ese motivo: es lo único que explica el movimiento cuando alguien lo revise en octubre.\n\n" +
          "**El importe va a UN solo tramo por día, nunca a los dos.** La tarifa cubre la ida y el retorno, así que el otro tramo queda en S/ 0.00 a propósito: si se escribiera en los dos, el cierre liquidaría el día como dos servicios y lo cobrarías dos veces. El ERP elige el tramo que ya lleva el importe y te dice cuántos días deja fuera y por qué — incluido el día que acabas de editar, cuyo hermano ya está cubierto.\n\n" +
          "Y el costo solo alcanza a los servicios que va a cubrir **esa misma empresa**: la tarifa que pactaste con una no es la de otra. Los de la flota propia quedan fuera, porque no le deben nada a ningún proveedor — y si el servicio que abriste quedó en flota propia, la casilla del costo sale apagada y te dice por qué: sin empresa, el ERP no sabe con cuál se pactó la tarifa que escribiría.",
      },
      {
        pregunta: "Escribí el precio nuevo en el modal y el servicio que tenía abierto se quedó con el viejo.",
        respuesta:
          "Es lo que hace, y te lo avisa en ámbar antes de aplicar. Ese modal pregunta por **los DEMÁS** servicios del contrato: el que tenías abierto ya se guardó cuando pulsaste *Guardar*, y el importe que escribes en el modal va a los otros.\n\n" +
          "No es un descuido, es lo que hace correcta la cuenta del día: el ERP necesita mirar ese servicio **tal como quedó** para saber cuál de los dos tramos de su día lleva la tarifa. Si además se la reescribiera, el cálculo se mordería la cola.\n\n" +
          "Dos formas de dejarlo igual que el resto:\n\n• Escribe el importe **en el formulario** antes de guardar — así ese servicio sale ya con el precio nuevo y el modal te lo ofrece prellenado para los demás.\n• O ciérralo, ábrelo otra vez y corrígelo solo a él.\n\n" +
          "Y si son varios los que quedaron con otra tarifa, el sitio para verlos todos juntos es **Liquidaciones → Precios/Costos del periodo**: ahí se ve el mes entero por ruta y se corrige de una vez.",
      },
      {
        pregunta: "Cambié la hora del contrato y en los paraderos sigue la hora vieja.",
        respuesta:
          "Eso era un defecto y ya está arreglado. **La hora de un servicio vive en dos sitios y antes solo se movía uno.**\n\n" +
          "Lo que se veía en la lista era `hora del servicio`; lo que de verdad llega a la calle es la hora de **cada paradero**: " +
          "de ahí salen el aviso al pasajero, el itinerario de la app del conductor, la hoja de ruta impresa y el semáforo de " +
          "puntualidad. Al correr el horario de un contrato, la fila cambiaba y los paraderos se quedaban con la hora anterior — " +
          "así que la que no se movía era justamente la que importaba.\n\n" +
          "Ahora, cambies la hora donde la cambies (en la fila, en el formulario o aplicándola a todo el contrato), **los paraderos " +
          "se corren con ella**. Tres cosas que conviene saber:\n\n" +
          "• **Se corren por el mismo desplazamiento, no se les pone a todos la hora nueva.** Si adelantas de 05:10 a 05:25, los " +
          "paraderos de 05:25 y 06:05 pasan a 05:40 y 06:20: el espaciado que planificaste se conserva.\n" +
          "• **Al paradero sin hora no se le inventa una**, y el que el conductor ya marcó conserva la suya: esa es la hora contra " +
          "la que se midió si llegó tarde.\n" +
          "• **Si el servicio no tiene paraderos propios, el ERP te lo dice** en vez de callarlo. Ese servicio saca su itinerario de " +
          "la cotización, así que la hora nueva hay que propagarla desde **Cotizaciones**, guardando la cotización y aceptando " +
          "*Propagar a futuros*.\n\n" +
          "Y si el servicio ya estaba sincronizado, te seguirá preguntando **“¿Re-notificar a los pasajeros?”**: se les avisó la hora anterior.",
      },
      {
        pregunta: "Un retorno sale con el aviso “SIN PARADEROS DE RETORNO” o “PARADEROS DE RETORNO SIN PROPAGAR”. ¿Qué hago?",
        respuesta:
          "El primero significa que **su cotización no tiene lista de paraderos de retorno**, solo la de ida. El segundo, " +
          "que la cotización sí la tiene pero **este servicio guarda otra lista** (casi siempre la de la ida, o una versión " +
          "vieja): se cargó la lista de retorno y no se propagó.\n\n" +
          "Los paraderos de los servicios de **hoy** se crean solos de madrugada, para que los pasajeros los vean en " +
          "*Elige tu ruta de hoy* sin que nadie tenga que abrirlos. Pero el retorno **no se deduce de la ida**: el paradero " +
          "de vuelta suele estar al otro lado de la pista (Puente Santa Anita hacia el norte no es el mismo que hacia el sur) " +
          "y tiene su propia hora. Así que a ese retorno el ERP no le crea paraderos hasta comprobar que son los de retorno, y " +
          "mientras tanto **sus pasajeros no lo verán** en la lista.\n\n" +
          "**Cómo se arregla** (los dos): en **Cotizaciones**, edita la cotización, revisa que tenga los paraderos de retorno con " +
          "sus horas, guarda y acepta *Propagar a futuros* (no *Solo esta cotización*). Desde ahí los retornos nuevos y los ya " +
          "programados llevan su lista.\n\n" +
          "Mientras tanto, si alguien abre ese servicio o el conductor lo inicia, recibe la lista que tenga guardada, como siempre.",
      },
      {
        pregunta: "¿Qué es el bloque violeta “Cierre administrativo”?",
        respuesta:
          "Es el **segundo ciclo** del servicio, el del dinero, y solo aplica a los que ya están *Finalizados*. Va aparte y en otro color justamente para que no se confunda con el ciclo operativo.\n\n**Un servicio finalizado arranca automáticamente en “Por liquidar”**: el viaje se hizo, pero todavía no se cerró cuánto se cobra ni se emitió nada. De ahí sigue a *Liquidada* → *Facturada* → *Cobrada*.\n\nEse contador de “Por liquidar” es tu cola de trabajo pendiente: cada número ahí es un viaje hecho que todavía no te ha pagado nadie. Se trabaja desde **Liquidaciones**.\n\nSi el servicio fue **tercerizado**, además corre el ciclo del proveedor (por conciliar → conciliada → por pagar → pagada). Que el cliente ya te haya pagado no significa que tú ya le pagaste a GRIJALVA TOURS.",
      },
      {
        pregunta: "El cliente me pide una salida extra que no está en el contrato. ¿Cómo la cargo?",
        respuesta:
          "Con el botón **Adicional**, el que está al lado de *Programa fijo*. Abre el mismo modal, pero preparado para eso:\n\n• **La cotización sigue siendo la del contrato** — de ahí salen los paraderos y el nombre de la ruta, que es justo lo que no quieres volver a teclear.\n• **Las fechas son sueltas**, no un rango con días de la semana: marcas el 12, el 14 y el 22 y listo.\n• **Eliges el sentido**: solo ida, solo salida, o las dos. Antes esto no se podía — si la cotización tenía hora de retorno, el sistema creaba siempre los dos tramos y había que cancelar a mano el que no ibas a hacer.\n• **El precio se escribe.** Arranca con el del contrato y al lado ves cuál era y cuánto estás cobrando de más o de menos. Si lo cambias, te pide el motivo.\n\nAntes esto se hacía generando un programa fijo y **corrigiendo el precio servicio por servicio**. Eso ya no hace falta.",
      },
      {
        pregunta: "¿Por qué es distinto marcarlo como adicional en vez de cargarlo como un servicio más?",
        respuesta:
          "Por tres cosas concretas:\n\n1. **En la liquidación sale en su propio renglón**, con el rótulo ADICIONAL y sumado en *Adicionales autorizados*. Si va sin marcar, se funde con las líneas del contrato: el cliente lee “23 servicios” donde hay 22 contratados y uno pedido aparte, y el subtotal de adicionales sale en cero.\n2. **Queda escrito el porqué.** Un adicional nace con su precio, así que no genera un acta de cambio de venta (esa salta cuando a un servicio ya creado se le toca el precio). El motivo que escribes al crearlo es el único registro de por qué esa salida costó distinto.\n3. **No ensucia la referencia de precios.** El ERP propone “la última vez que cobraste esta ruta: S/ …”. Un adicional de S/ 480 por una unidad mayor no se propone nunca como tarifa del contrato.\n\nEn la lista los reconoces por el chip naranja **ADICIONAL**, y arriba tienes el filtro *Todo origen / Contrato / Adicionales*.",
      },
      {
        pregunta: "Quiero marcar como adicional un solo tramo, pero el sistema arrastra el hermano. ¿Cómo lo evito?",
        respuesta:
          "Con la casilla **Cambiar solo el tramo marcado**, en el mismo modal. Viene apagada porque lo normal es que los dos tramos vayan juntos —**lo que se cobra es el día**, no el tramo: la ida y la salida llevan una sola tarifa—, pero cuando lo que cambió de manos fue un tramo, se enciende y el hermano no se toca.\n\nAntes de aplicar, el ERP te dice qué va a pasar de verdad, porque **quien clasifica el día es el tramo que lleva la tarifa**:\n\n• Marcas el tramo donde está el importe → **el día completo** cambia de subtotal.\n• Marcas el tramo que va en S/ 0.00 (el retorno, casi siempre) → **la valorización no se mueve**. La marca queda como registro de que fue ese tramo el que cambió, y nada más.\n\nNinguna de las dos está mal. Lo que estaría mal es no saber cuál de las dos estás haciendo, y por eso la frase sale en pantalla con el importe y el código del tramo que lo lleva.\n\nEn la liquidación, un par con los dos tramos en lados distintos **sale en los avisos** del cierre. Ojo: ese panel muestra los primeros seis y luego “y N más…”, así que si marcas muchos tramos sueltos de golpe, tus propios avisos pueden empujar fuera de la vista a los de dinero. Marca en lote solo cuando de verdad sean todos el mismo caso.",
      },
      {
        pregunta: "Marqué el retorno como adicional y en la liquidación el día sigue saliendo como contrato. ¿Es un error?",
        respuesta:
          "No: es la regla, y el modal te lo avisó al marcarlo. El origen del día lo declara **el tramo que lleva el importe**, y en un par normal ese es la ida — el retorno va en S/ 0.00 porque la tarifa cubre los dos tramos.\n\nSi lo que quieres es que **el día entero** se cobre como adicional, tienes dos caminos:\n\n• Apagar *Cambiar solo el tramo marcado* y marcar el par completo, que es lo que hace el modal por defecto.\n• O marcar el tramo que sí lleva la tarifa.\n\nY si el día no debía cambiar de bolsillo —solo querías dejar constancia de que ese retorno lo cubrió otra unidad—, entonces está exactamente como debe estar.",
      },
      {
        pregunta: "Dos servicios del mismo día se intercambiaron las unidades. ¿Cómo lo corrijo sin mover el dinero de sitio?",
        respuesta:
          "Con el **canje**, que en el modal se llama **⇄ Fue un intercambio con otro servicio** (aparece al abrir *Marcar como ADICIONAL* o *Devolver a CONTRATO*).\n\nEs para cuando la etiqueta no sobra, sino que está en el servicio equivocado: sale la ruta contratada y además un adicional, hay una contingencia, y las unidades se cambian el trabajo. Marcar uno solo movería un día de subtotal; canjearlos deja la cuenta igual.\n\nCómo funciona:\n\n• Eliges la contraparte entre los servicios **del mismo cliente que hoy llevan la etiqueta que este va a tomar**, dentro de ±3 días.\n• Los dos cambian a la vez: este pasa a adicional y el otro vuelve a contrato.\n• Antes de aplicar ves cuánto entra y cuánto sale de *Adicionales autorizados*. Si las dos tarifas son iguales, el neto es **cero**.\n• Si además enciendes *Cambiar solo el tramo marcado*, se intercambian los tramos elegidos y no los días enteros.\n\nSi no aparece ninguna contraparte, es que el otro servicio todavía no está marcado: el canje necesita los dos lados.",
      },
      {
        pregunta: "En el canje me piden motivo y nota obligatorios. ¿Por qué, si no estoy cambiando ningún precio?",
        respuesta:
          "Porque es el **único sitio donde queda escrito**. Cambiar el origen no genera acta de venta (esa salta cuando se toca costo, precio, proveedor o vehículo), así que no hay ningún otro registro del movimiento. Y el lado que vuelve a *contrato* **borra** su motivo y su nota, porque describían un adicional que ya no existe.\n\nQueda entonces una sola nota, en el servicio que pasa a adicional, y ahí el ERP escribe además el **código de su contraparte**. Eso es lo que permite reconstruir el intercambio tres meses después, cuando alguien pregunte por qué esa salida figura aparte.\n\nEscribe lo que pasó de verdad: *“La unidad del adicional cubrió el retorno del contrato por avería”*. Un “corrección” a secas no le sirve a nadie en octubre.",
      },
      {
        pregunta: "No encuentro un servicio de hace tres meses. ¿Se borró?",
        respuesta:
          "No. Por velocidad, la lista abre mostrando solo una **ventana de fechas**: 30 días hacia atrás y 90 hacia adelante. Un contrato fijo genera cientos de filas y traerlas todas cada vez hacía la pantalla lentísima.\n\nTienes dos salidas:\n• Poner el rango en **Desde / Hasta** — es lo rápido si sabes la fecha.\n• Pulsar **🕘 Ver todo**, que carga el histórico completo. Es más lento, úsalo para buscar.\n\nAbajo a la derecha, el contador te avisa de en qué modo estás: cuando dice “· ventana”, no estás viendo todo.",
      },
    ],
    comoHacer: [
      {
        titulo: "Programar un servicio y avisar a los pasajeros",
        pasos: [
          "Filtra con el botón “⚡ Por asignar” para ver solo los servicios que no tienen recurso.",
          "Haz clic en el servicio. En el formulario elige si lo cubre Flota propia o una Empresa tercerizada.",
          "Si es propio: elige vehículo y conductor. Si es tercerizado: elige la empresa y, si los tienes cargados, su placa y su conductor.",
          "Guarda. El estado avanza solo: un servicio EVENTUAL queda en Programada (falta que el cliente confirme) y uno FIJO pasa directo a Confirmada, porque el contrato ya es la confirmación.",
          "Abre “Manifiesto” en la fila del servicio. Revisa las paradas (con sus horas) y los pasajeros asignados a cada una.",
          "Pulsa sincronizar. Recién ahí el conductor ve el servicio en su app y los pasajeros reciben el aviso.",
        ],
        advertencia:
          "Si el vehículo tiene una orden de trabajo abierta en el taller, el ERP te lo advierte al elegirlo. No te bloquea, pero coordínalo antes: un bus que entra a taller el día del servicio deja a un cliente en tierra.",
      },
      {
        titulo: "Generar todos los servicios de un contrato fijo",
        pasos: [
          "La cotización tiene que estar APROBADA en el módulo de Cotizaciones. Sin eso no hay contrato que generar.",
          "En Programación pulsa el botón “Programa fijo” (arriba a la derecha).",
          "Elige la cotización, el rango de fechas y qué días de la semana opera.",
          "Revisa el resumen antes de confirmar: te dice cuántos servicios va a crear y con qué precio por día.",
          "Confirma. Los servicios nacen en Pendiente, ya vinculados a esa cotización, y la lista se filtra sola por “Fijos”.",
          "Para tocar todo el contrato de una vez: abre UNO de esos servicios, cámbiale lo que sea y guarda. El ERP te pregunta “¿Aplicar a más servicios del contrato?” y te deja marcar, por separado, qué se propaga: la asignación, la hora, los PAX contratados, el precio de venta o el costo del proveedor — con un rango de fechas si solo quieres una parte.",
        ],
        advertencia:
          "Genera solo el tramo que ya tienes cerrado con el cliente. Justo después de generar aparece un aviso verde con un botón “Deshacer”: es la forma rápida de arrepentirte. Más adelante también se pueden borrar en lote (el ERP te obliga a escribir cuántos servicios estás eliminando), pero no deja borrar los que ya tienen factura, y mientras tanto esos servicios de más ensucian los números del periodo.",
      },
    ],
    relacionadas: [
      { etiqueta: "Liquidaciones · cerrar lo finalizado", href: "/liquidaciones" },
      { etiqueta: "Seguimiento del día", href: "/seguimiento" },
      { etiqueta: "Calendario", href: "/calendario" },
      { etiqueta: "Cotizaciones", href: "/cotizaciones" },
      { etiqueta: "Pasajeros", href: "/pasajeros" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DESPACHADOR
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "despachador",
    rutas: ["/despachador"],
    titulo: "Despachador · el servicio que sale ahora",
    resumen:
      "Es la ventanilla rápida: te llaman pidiendo una unidad para dentro de una hora y necesitas crear el servicio en un minuto, viendo al mismo tiempo qué buses tienes libres y dónde están.",
    paraQueSirve: [
      "Crear un servicio urgente sin pasar por cotización.",
      "Ver en el mapa, mientras lo creas, qué unidades están disponibles y dónde andan.",
      "Registrar un cliente nuevo en el mismo formulario, sin salir de la pantalla.",
      "Saber cuántos vehículos y conductores tienes libres ahora mismo.",
    ],
    conceptos: ["tercerizado", "margen"],
    faqs: [
      {
        pregunta: "¿En qué se diferencia de Programación?",
        respuesta:
          "En el ritmo. **Programación** es para planificar: contratos, semanas por delante, manifiestos, paraderos. **Despachador** es para responder al teléfono.\n\nEl servicio que creas aquí nace directamente en estado **Confirmada** (no pasa por pendiente ni programada) y queda marcado como venido del despachador. Aparece de inmediato en Programación como cualquier otro servicio, y desde ahí sigue el mismo camino que todos.",
      },
      {
        pregunta: "Despaché el servicio. ¿Qué me falta hacer después?",
        respuesta:
          "Tres cosas, y ninguna la hace el despachador por ti:\n\n1. **El precio.** Si lo dejaste en cero por las prisas, ese servicio va a aparecer con margen cero y va a ensuciar tus reportes. Complétalo en Programación.\n2. **La cotización.** En la cabecera de **Cotizaciones** aparece un chip morado del tipo *“⚡ 3 sin cotizar (Despachador)”*: son los despachos que todavía no tienen cotización asociada. Si el cliente pide sustento formal, ahí se genera.\n3. **El manifiesto**, si el servicio lleva pasajeros con paraderos. El despachador solo guarda un **texto libre** con los nombres de los pasajeros; no arma paradas, no asigna paraderos y no avisa a nadie.",
      },
      {
        pregunta: "El mapa de la derecha, ¿es tiempo real?",
        respuesta:
          "Casi. Se refresca **cada 12 segundos** con las últimas posiciones que mandaron los teléfonos de los conductores en servicio. Sirve perfectamente para decidir a qué unidad le queda más cerca el pasajero.\n\nSi quieres el seguimiento fino de un servicio en marcha, la pantalla es **Monitoreo**, que además trae las alertas SOS y el estado de señal de cada unidad.",
      },
    ],
    relacionadas: [
      { etiqueta: "Programación", href: "/programacion" },
      { etiqueta: "Monitoreo GPS", href: "/monitoreo" },
      { etiqueta: "Cotizaciones", href: "/cotizaciones" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CALENDARIO
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "calendario",
    rutas: ["/calendario"],
    titulo: "Calendario · los servicios en el tiempo",
    resumen:
      "Es la misma información de Programación, pero dibujada en un calendario de mes, semana o día. Sirve para ver huecos, choques de horario y qué tan cargada viene la semana.",
    paraQueSirve: [
      "Ver la carga de trabajo de un día, una semana o un mes de un vistazo.",
      "Detectar días saturados antes de comprometer un servicio nuevo.",
      "Distinguir de un golpe los servicios fijos (contratos) de los eventuales.",
      "Abrir un servicio y ver su precio, su costo y su margen sin salir del calendario.",
    ],
    conceptos: ["margen", "tercerizado"],
    faqs: [
      {
        pregunta: "¿Qué significan los colores?",
        respuesta:
          "El color del bloque es el **estado del servicio**, el mismo código que usa todo el ERP: amarillo *pendiente*, celeste *programada*, verde *confirmada*, azul *en curso*, violeta *finalizada*, rojo *cancelada*.\n\nEn la misma barra de filtros, a la derecha, está la leyenda de **Tipo**: azul marino para los servicios **fijos** (contratos de transporte de personal, los que se repiten todos los días) y violeta para los **eventuales** (un traslado puntual).\n\nLas pastillas de la fila **Estado:** son filtros, no solo leyenda: púlsalas para dejar en pantalla solo lo que te interesa, y usa **Limpiar** para volver a verlo todo.",
      },
      {
        pregunta: "Puedo cambiar el estado desde el calendario. ¿Debería?",
        respuesta:
          "Para *confirmada*, *finalizada* o *cancelada*, sí: es un atajo cómodo.\n\n**Pero no toques “en curso”.** Aunque el botón esté ahí, ese estado significa una sola cosa: *el conductor hizo su check-in por GPS y el bus está rodando*. Si lo marcas tú desde la oficina, el servicio aparecerá como en ruta en Monitoreo y en Seguimiento sin que haya ningún bus mandando posición, y el tablero de puntualidad se vuelve inútil.\n\nSi el conductor se olvidó de iniciar, la solución es llamarlo, no marcarlo.",
      },
      {
        pregunta: "¿Puedo crear un servicio desde aquí?",
        respuesta:
          "No. El calendario **solo muestra y deja cambiar el estado**. Los servicios se crean en **Programación** (uno a uno o generando un contrato fijo) o en el **Despachador** si es urgente.\n\nEs a propósito: crear un servicio pide cliente, precio, unidad, conductor y paraderos, y eso no cabe en un clic sobre una casilla del calendario.",
      },
    ],
    relacionadas: [
      { etiqueta: "Programación", href: "/programacion" },
      { etiqueta: "Seguimiento del día", href: "/seguimiento" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SEGUIMIENTO
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "seguimiento",
    rutas: ["/seguimiento"],
    titulo: "Seguimiento operativo · cómo va el día",
    resumen:
      "Es la torre de control de un día concreto: qué servicios hay, cuáles ya salieron, cuáles van tarde, cuántos pasajeros subieron y qué documento le falta a cada unidad para poder salir.",
    paraQueSirve: [
      "Saber, sin llamar a nadie, qué buses ya salieron y cuáles no.",
      "Distinguir un retraso de verdad de un “no tengo señal para opinar”.",
      "Ver cuántos pasajeros abordaron contra cuántos estaban en el manifiesto.",
      "Imprimir el Manifiesto MTC y el Reporte de Servicio de cada viaje.",
      "Detectar servicios finalizados que nunca arrancaron su cierre administrativo.",
      "Etiquetar RUTA, TURNO y MÓVIL de los servicios del día (🏷 Etiquetas): deciden los ítems de la liquidación.",
      "Saber, en la ficha de cada servicio, qué avisos se le mandaron al conductor para que no olvide INICIAR y si le llegaron o los leyó (bloque «Avisos al conductor»).",
      "Saber si los cortes de rastreo de un conductor son por su teléfono, por la configuración o por la red, y qué le falta configurar (clic en el % de Rastreo).",
    ],
    conceptos: ["estado_admin", "conformidad", "liquidacion_cliente", "tercerizado"],
    faqs: [
      {
        pregunta: "¿Le llegaron al conductor los avisos para que no olvide iniciar el servicio?",
        respuesta:
          "Ábrelo en la ficha del servicio, bloque **Avisos al conductor**. Cada aviso sale con su hora, su canal (WhatsApp o la notificación del app) y lo que se sabe de él: **Leído**, **Entregado, sin confirmación de lectura**, **Enviado, sin confirmación de entrega** o **No se entregó** con el motivo de Meta.\n\n" +
          "Mientras el servicio siga sin iniciar, al conductor le llegan, en este orden: el aviso de 90 min antes, **«Inicia ahora»** 5 min antes, **«Ya debió iniciar»** 1 min después de la hora y, si sigue igual, a los 10 min **«No inició»**, que le llega al coordinador con el resumen de lo que ya se le mandó (al conductor no se le repite si «Ya debió iniciar» ya le mandó ese mismo mensaje).El de 30 min antes existe pero se apagó (ya se avisa a los 90); su tarjeta sigue ahí por si se quiere volver a encender. Cada uno se configura en **Configuración → Alertas y Mensajes**, y ahí mismo **🧪 Probar los avisos** te los manda a tu WhatsApp, en orden y con datos de ejemplo.\n\n" +
          "Si está encendida la **llamada de la central** (3 min después de la hora), en el mismo bloque sale cada llamada con lo que pasó: **contestó** (y si marcó 1 «ya estoy en ruta» o 2 «quiero hablar con el coordinador»), **no contestó**, **no se llamó** porque ya había iniciado, o **no salió** porque la central no estaba conectada.\n\n" +
          "Dos cosas para leerlo bien:\n\n" +
          "• **«Entregado» sin «leído» no significa que lo ignoró**: quien apaga la confirmación de lectura en WhatsApp nunca manda «leído».\n" +
          "• **Si ningún WhatsApp le llegó**, la ficha lo dice en ámbar: el teléfono no tenía datos o estaba apagado, y sin datos el app tampoco funciona. Ahí lo que sirve es **llamarlo**.\n\n" +
          "Los avisos procesados antes de este registro salen como «procesado por el sistema, sin detalle»: se intentaron, pero entonces no se guardaba por dónde ni si llegaron.",
      },
      {
        pregunta: "¿Qué es el botón «🏷 Etiquetas» y el chip azul debajo de la ruta?",
        respuesta:
          "El chip («🏷 RUTA A · T1 · 50 PAX») dice en qué **ítem de la liquidación** va ese servicio: todos los que comparten RUTA, TURNO y MÓVIL (con los mismos PAX contratados y tarifa) se cobran en un solo renglón, aunque cambie la hora.\n\nEl botón **🏷 Etiquetas** abre la propuesta del ERP para los servicios que estás viendo: la RUTA sale del nombre («RUTA A/ …») y tú escribes el TURNO por grupo (los días van agrupados por hora de salida); se escriben en la ida y el retorno. Si filtras primero (por ejemplo, buscando «RUTA C»), solo se etiquetan esos.\n\nPara etiquetar semanas o meses de una vez es más cómodo hacerlo desde **Programación** o desde el cierre de **Liquidaciones**, que ven varios días juntos.",
      },
      {
        pregunta: "El panel de Puntualidad, ¿qué me está diciendo exactamente?",
        respuesta:
          "Está separando cosas que antes se mezclaban en un solo número rojo. Los cuatro que más vas a ver:\n\n• **Retraso confirmado** — hay evidencia de que salió tarde. Esto sí es un problema.\n• **En el punto, sin iniciar** — el GPS ubica el bus **en el paradero**. No va tarde: falta que el conductor pulse Iniciar en su app. Se arregla con una llamada de 10 segundos.\n• **Sin rastreo** — no llega señal de ese teléfono. **El ERP nunca afirma un retraso por falta de GPS**: no saber no es lo mismo que ir tarde, y decir lo contrario te haría regañar a un conductor que iba puntual.\n• **Riesgo de retraso** — una previsión con el tráfico de ahora. Todavía se puede reaccionar.\n\nHay más niveles y solo aparecen si ese día se dieron: *No se realizó*, *Retraso en ruta*, *Inició tarde* y *En hora*.\n\nCada nivel es un botón: púlsalo y la lista de abajo se filtra. El panel completo **solo sale cuando la fecha elegida es hoy** — mirando un día pasado no tendría sentido hablar de riesgo ni de tráfico.",
      },
      {
        pregunta: "La torre dice que llegará tarde a un paradero por el que el bus YA pasó. ¿Por qué?",
        respuesta:
          "Ya no debería. Eso pasaba porque *“el siguiente paradero”* se respondía mirando **el botón del conductor**, no el GPS: si no marcaba —que es lo habitual—, el sistema seguía creyendo pendiente un paradero que el bus había dejado atrás hacía media hora, medía la distancia hasta **allá atrás** y la llamaba retraso.\n\nEl efecto era el contrario del que parece: **el “retraso” crecía cuanto mejor iba el servicio**, porque cada kilómetro que el bus avanzaba por su ruta lo alejaba más del paradero equivocado. Y no se quedaba en la pantalla: ese mismo aviso salía por WhatsApp.\n\nAhora la torre usa **el mismo motor de avance que el mapa**: el que en el detalle GPS te dice *“2 parada(s) pasada(s) sin marcar”*. Las dos mitades del tablero ya no pueden contradecirse.\n\nDos cosas que conviene tener claras:\n\n• **El botón del conductor sigue mandando.** El GPS solo **suma** paraderos pasados, nunca desmarca uno que el conductor marcó.\n• **Cuando el objetivo lo movió el GPS, el aviso lo dice** — verás algo como *“objetivo por GPS (Bertello sin marcar)”*. Si lo lees, es que en la app del conductor ese paradero sigue pendiente: el viaje va bien, lo que falta es la marca.",
      },
      {
        pregunta: "¿De dónde sale la hora real de salida? Nadie la escribe.",
        respuesta:
          "Exacto, y por eso el ERP **la deduce de lo que el conductor sí dejó**: la hora en que marcó la primera parada, la hora del primer abordaje con QR, el aviso de salida a los pasajeros o el primer punto GPS del viaje.\n\nEn la columna **Salió**, la hora sale en **verde** cuando es un dato firme y en **gris y cursiva** cuando es una estimación. Pasa el cursor por encima y te dice de dónde salió: *“marcado por el conductor 05:12”*, *“abordaje QR 05:14”*, *“estimado por GPS ~05:16”*. **Ese “~” no es adorno: marca que la hora está inferida y que no debería facturarse como si fuera un dato duro** — el reloj de un teléfono puede estar desfasado.\n\nEl contador **Sin hora de salida** cuenta los servicios donde no hay ninguna evidencia. Suele ser un teléfono con el rastreo apagado, no un bus que no salió — revísalo en **Salud del GPS**.",
      },
      {
        pregunta: "¿Qué mide la columna Rastreo y el aviso «unidades con rastreo incompleto»?",
        respuesta:
          "**Qué parte del tiempo del servicio llegó posición GPS**, desde que el conductor lo inicia hasta que llega al último paradero. No mide el tramo entre la primera y la última señal: si el teléfono deja de transmitir a los 3 minutos de una ruta de 55, el servicio sale con un 5 %, no con un 100 %.\n\n" +
          "Si el conductor **cierra el servicio antes** desde su app (por ejemplo, ya no quedaban pasajeros en los últimos paraderos), la medición termina en ese cierre y no en la llegada prevista: después de Finalizar la app deja de transmitir a propósito, y eso no es un GPS malo. Pasa el cursor sobre el porcentaje y te dice de dónde sale el final: el cierre del conductor, la última parada que marcó o la hora prevista.\n\n" +
          "• **Completo** (95 % o más) y **Aceptable** (90 %) — el viaje se puede reconstruir.\n" +
          "• **Con cortes** (70 a 89 %) — hubo huecos de señal.\n" +
          "• **Incompleto** (menos de 70 %) — el viaje no se puede reconstruir.\n" +
          "• **Sin señal** — el servicio se hizo y no llegó ninguna posición.\n" +
          "• **Inmóvil** — llegaron posiciones, pero todas en el mismo punto mientras el recorrido avanzaba: el teléfono no iba en el bus.\n\n" +
          "El aviso separa dos cosas que se atienden distinto: **En ruta sin señal ahora** (más de 5 minutos sin posición con el servicio en curso: llama al conductor, casi siempre es la app cerrada o el teléfono bloqueado) y **Rastreo incompleto**, que ya quedó en el registro del viaje. El titular cuenta **unidades**, no servicios: una unidad con el teléfono mal configurado falla en todos sus viajes y es un solo problema. Cada contador filtra la lista.\n\n" +
          "**Haz clic sobre el porcentaje** (o sobre una fila del aviso) y se abre el **diagnóstico** de ese servicio: por qué se cortó cada tramo y cómo estaba configurado el teléfono del conductor. Está explicado en la pregunta siguiente.\n\n" +
          "Es el mismo cálculo de **Salud del GPS**, donde ves el historial por conductor para saber a quién hay que configurarle el teléfono.\n\n" +
          "En el mapa del detalle GPS, **un servicio terminado se ajusta a la vía una sola vez y ese recorrido se guarda para siempre**: las siguientes aperturas lo dibujan sin volver a calcularlo. Si después llegan posiciones tardías, se recalcula **como mucho dos veces**. Un servicio **en curso** se sigue ajustando en vivo, como siempre. Junto a la leyenda de la huella verás un aviso que dice cuál de los dos casos es.",
      },
      {
        pregunta: "¿Qué me dice el clic sobre el porcentaje de Rastreo?",
        respuesta:
          "Abre el **diagnóstico del rastreo** de ese servicio sin salir de la pantalla. Contesta lo que el porcentaje no dice: **por qué se cortó, y qué hay que hacer**. El porcentaje de arriba es el mismo de la celda: sale del mismo cálculo.\n\n" +
          "**Cada tramo sin rastreo lleva su causa:**\n" +
          "• **App detenida** — el teléfono dejó de enviar mientras el servicio seguía: el sistema cerró la app o la durmió. Casi siempre es la configuración del teléfono.\n" +
          "• **Por antena** — el teléfono sí enviaba, pero sin satélite: posiciones imprecisas que no sirven para seguir el viaje.\n" +
          "• **Sin datos móviles** — las posiciones se guardaron en el teléfono, llegaron tarde y parte se perdió.\n" +
          "• **No se sabe** — no hay prueba de que el servicio siguiera (la señal se cortó y el conductor no cerró ni marcó nada después).\n\n" +
          "Aparte van dos cosas que **no restan del porcentaje**:\n" +
          "• **GPS congelado** — llegaron posiciones repetidas y después el bus apareció más allá. Ese tiempo cuenta como rastreado, pero el recorrido real no quedó registrado.\n" +
          "• **Llegadas tardías** — sin datos móviles el teléfono guarda las posiciones y las manda al recuperar señal. Llegan tarde, pero el registro del viaje está completo.\n\n" +
          "**Su teléfono:** la app del conductor reporta cómo está configurado —app instalada o navegador, batería sin restricciones, ubicación «todo el tiempo», rastreo en segundo plano, ubicación precisa y alta precisión— y el modal lo pinta con ✓ o ✗. Lo que **no se pudo comprobar** (navegador, app antigua, el teléfono no contestó) sale como **«— no se pudo comprobar»** en gris, **nunca como ✗**: no saber no es lo mismo que estar mal.\n\n" +
          "**Qué le falta configurar** pone primero lo que explica el corte, cada cosa con su arreglo, y después los pasos para la marca de su teléfono. Ojo: el **inicio automático** y **bloquear la app en Recientes** son ajustes del fabricante que la app **no puede leer**. Si todo lo demás está bien y la app igual se detuvo, es ahí donde hay que mirar con el conductor.\n\n" +
          "**No hace falta reinstalar la app** para que reporte: basta con que el conductor la abra. Solo si el modal dice **«APK antiguo»** conviene instalar la versión actual.\n\n" +
          "Abajo salen **sus últimos servicios**, para saber si el corte es de este viaje o le pasa siempre, con un enlace a **Salud del GPS**.\n\n" +
          "Si el modal avisa en ámbar que falta **supabase/gps-equipo-01.sql**, el teléfono del conductor todavía no puede reportar su configuración (esa parte sale vacía) y tampoco se puede saber qué llegó tarde.",
      },
      {
        pregunta: "Me sale “Riesgos de flota detectados”. ¿Qué tan grave es?",
        respuesta:
          "Depende de cuál de los tres sea, y la propia pantalla te lo aclara:\n\n• **Documentos vencidos** — esto sí es duro: SOAT, revisión técnica o habilitación vencidos **bloquean la salida**. Si sale y lo paran, es multa y servicio caído.\n• **Solape de unidad o conductor** — el mismo bus o el mismo chofer en dos servicios que no se pueden hacer seguidos. Cada servicio se mide de su primer a su último paradero (o con sus horas reales, si ya se hizo), y entre uno y el siguiente se estima el traslado del último paradero al primero: en **rojo** si los recorridos se pisan, en **ámbar** si no da el tiempo de trasladarse (es una estimación a velocidad de ciudad, no un ETA) y en **gris** («sin confirmar») si a un servicio le falta el itinerario y solo se pisaría suponiéndole 4 h — ahí lo que hay que hacer es completar sus paraderos. El detalle de cada servicio dice con cuál choca y por cuánto.\n• **Conductor sobre el tope de conducción** — cuenta las **horas al volante** de cada servicio según el RENAT (art. 30): no más de 5 h seguidas de día (4 h de noche) sin un descanso de 1 h (30 min si condujo menos de 2 h), ni más del tope del día (10 h por norma; se configura en «Alertas y Mensajes», tarjeta «Jornada extensa»). El **horario partido** —entrada de madrugada, retorno por la tarde y descanso en medio— **no** es jornada extensa: la espera no es conducción. Es un piso: no ve los traslados en vacío.\n\nEn resumen: el primero actúalo, los otros dos revísalos.",
      },
      {
        pregunta: "La columna Ruta, ¿es la que ve el pasajero? ¿La puedo corregir desde aquí?",
        respuesta:
          "Sí a las dos cosas, y por eso está en esta pantalla. Ese texto es **el mismo que el pasajero lee en su app para elegir su bus**: lo cambias aquí y lo verá la próxima vez que abra la pantalla. Si lo dejas vacío, al pasajero —y al cliente en su portal— le sale **“Sin nombre”**, y para distinguir un servicio de otro solo le queda el **ORIGEN → DESTINO**, que va debajo en letra pequeña. Eso se reconoce mucho peor que un “RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA”, y bastante peor todavía cuando el paradero nunca se renombró y ese origen es la dirección geocodificada (“W2VG+39R, EL AGUSTINO 15022, PERÚ”).\n\n**El nombre y el ORIGEN → DESTINO son dos datos distintos y ninguna pantalla sustituye uno por el otro**: sin nombre no se rellena el hueco con el recorrido, se dice que falta. Por eso dejarlo vacío se nota — y por eso se puede arreglar.\n\nPara editarlo, **haz clic sobre el nombre** en la propia fila: se abre el campo ahí mismo, guardas con **Enter** o pulsando fuera, y **Esc** cancela sin guardar. Es el mismo dato que ya podías tocar en **Configurar ruta**, dentro del Manifiesto en Programación — solo que ahora no hace falta abrir el manifiesto de cada servicio para verlo.\n\n**Respeta el formato que ya usa la operación.** No es un rótulo decorativo: **este texto se imprime tal cual en la liquidación**, en el renglón del servicio que el cliente firma, y además es la identidad con la que se agrupan los servicios del mes (misma ida + mismo retorno + misma tarifa = un solo ítem). El costeo de pactos, por su lado, busca la ruta por su nombre **exacto**. Si le cambias el nombre a la mitad del mes, esa ruta sale partida en dos renglones en la valorización.",
      },
      {
        pregunta: "Ese nombre se repite todos los días. ¿Tengo que corregirlo fila por fila?",
        respuesta:
          "No. Mientras estás escribiendo el nombre en la fila te aparece **“Aplicar a varios días…”**, y ahí se hace de una vez para toda la temporada.\n\nPrimero eliges **a cuáles**:\n\n• **La misma ruta** — los servicios con los mismos paraderos, en el mismo orden y el mismo sentido, de la misma cotización. Es el criterio fino, y **el único que sirve cuando el servicio todavía no tiene nombre**, que es justo cuando hay que ponérselo.\n• **Los que hoy se llaman igual** — para **renombrar** una ruta que ya estaba bautizada. Este no necesita cotización, así que también sirve para servicios sueltos.\n\nDespués eliges el rango (de este servicio en adelante, dos semanas, este mes, o las fechas que quieras) y **te sale la lista antes de aplicar**: fecha, hora, placa, cliente y **cómo se llama hoy cada uno**. Cada fila viene etiquetada — *Se completa* (estaba en blanco), *Se reemplaza* (**tenía otro nombre, en ámbar**) o *Ya lo tiene* (no se toca). Puedes destildar los que no quieras, o usar el atajo **“Solo los que están en blanco”**, que es la jugada segura cuando solo vas a rellenar huecos.\n\nDos cosas que conviene saber:\n\n• **Los servicios finalizados y cancelados quedan fuera a propósito**, y la pantalla te dice cuántos. Su nombre ya viajó a la liquidación, y reescribirlo hacia atrás cambiaría un papel ya emitido.\n• **Si te equivocas, hay “Deshacer”** justo después de aplicar: devuelve a cada servicio el nombre que tenía, no un nombre común. Mientras no cierres la ventana.",
      },
      {
        pregunta: "En la ficha del servicio dice “Pendiente de pasar a liquidación”. ¿Qué hago?",
        respuesta:
          "Significa que el servicio está **finalizado** pero nunca arrancó su ciclo administrativo, así que **no aparece en la cola de Liquidaciones**: es un viaje hecho que nadie va a cobrar, porque el sistema no lo está mostrando en ninguna lista de pendientes.\n\nPulsa **Marcar “Por liquidar”** en ese mismo aviso. A partir de ahí entra a la cola normal: por liquidar → liquidada → facturada → cobrada.\n\nDesde esta misma ficha imprimes también el **Manifiesto MTC** y el **Reporte de Servicio**, que son los papeles que te va a pedir el cliente corporativo para dar la conformidad.",
      },
    ],
    relacionadas: [
      { etiqueta: "Monitoreo GPS · el mapa", href: "/monitoreo" },
      { etiqueta: "Salud del rastreo GPS", href: "/gps-salud" },
      { etiqueta: "Liquidaciones", href: "/liquidaciones" },
      { etiqueta: "Programación", href: "/programacion" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MONITOREO GPS  (+ SALUD DEL GPS)
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "monitoreo",
    rutas: ["/monitoreo", "/gps-salud"],
    titulo: "Monitoreo GPS · dónde están las unidades",
    resumen:
      "Dos pantallas hermanas. **Monitoreo** es el mapa en vivo: dónde está cada unidad, cuáles hay que atender y qué alertas SOS hay abiertas. **Salud del rastreo** responde la otra pregunta: a qué conductores se les corta la señal durante el servicio, y por qué.",
    paraQueSirve: [
      "Ver en el mapa la flota propia y la tercerizada, con su placa y su estado; las que no transmiten siguen en su última posición, en gris y con su edad.",
      "Saber de un vistazo qué hay que atender: SOS, servicios que no se iniciaron y unidades en ruta sin señal.",
      "Atender alertas SOS que manda el conductor desde su app.",
      "Contestar al cliente “¿dónde está mi bus?” sin llamar al conductor, también desde el celular.",
      "Descubrir qué teléfonos están mal configurados y dejan viajes sin rastro.",
    ],
    faqs: [
      {
        pregunta: "Un bus salió pero no aparece en el mapa. ¿Está mal el GPS?",
        respuesta:
          "Casi nunca es el GPS del vehículo: el rastreo lo hace **el teléfono del conductor a través de su app**, y solo mientras el servicio está iniciado.\n\nRevisa en este orden:\n1. ¿El conductor **inició el servicio** en la app? Sin iniciar, no manda nada.\n2. ¿El servicio está **sincronizado** desde Programación? Si no, ni siquiera le aparece en su lista.\n3. ¿El teléfono tiene el permiso de ubicación en **“Permitir siempre”**? Si está en “Solo mientras uso la app”, el sistema operativo corta el rastreo apenas el conductor bloquea la pantalla.\n\nOjo: una unidad que **dejó de transmitir no desaparece**: se queda en gris en su última posición. Si una unidad no está en el mapa es porque **no tiene ninguna posición en los últimos 30 días** (en la lista dice «Sin posición»), o porque esta vez **no se pudo leer** (dice «No se pudo leer» y se reintenta cada minuto: no quiere decir que no tenga posición).",
      },
      {
        pregunta: "¿Qué significa cada color del mapa?",
        respuesta:
          "**Verde · En línea**: mandó su posición hace 2 minutos o menos.\n\n**Ámbar · Demora**: está en servicio y lleva entre 2 y 5 minutos sin posición nueva. Todavía no es una alarma: suele ser un túnel o una zona sin datos.\n\n**Rojo · Atender**: hay que hacer algo. Es una de tres cosas: una **alerta SOS** sin atender, un servicio cuya hora ya pasó y el conductor **no pulsó Iniciar** (aunque su teléfono esté transmitiendo), o una unidad **en servicio y más de 5 minutos sin señal**. El detalle de cada unidad dice cuál de las tres es.\n\n**Gris · Estacionada o Cerró servicio**: no tiene ningún servicio en curso. Se dibuja en su **última posición conocida**, atenuada y con su edad debajo de la placa (“hace 3 h”, “ayer 18:40”). Gris no es una falla: una unidad guardada en la cochera tiene que verse gris.\n\nLos contadores de arriba (**Atender · En línea · Demora · Estacionadas · Sin dato**) también son filtros: tócalos para dejar en la lista y en el mapa solo esa clase, y vuelve a tocarlo para verlas todas. **Sin dato** junta las que no tienen posición en 30 días y las que no se pudieron leer.",
      },
      {
        pregunta: "Hay demasiados grises en el mapa. ¿Puedo ocultarlos?",
        respuesta:
          "Sí. El interruptor **Estacionadas en el mapa** quita los grises del **mapa** (la lista los sigue mostrando, para que no se pierdan de vista). La elección se recuerda en este navegador.\n\nAdemás, con el mapa **alejado** las placas de los grises se ocultan solas y solo queda el ícono; acerca el mapa para leerlas. Si tocas una unidad gris en la lista, se ve igual aunque el interruptor esté apagado.",
      },
      {
        pregunta: "¿Cómo se usa desde el celular?",
        respuesta:
          "Arriba tienes dos botones: **Mapa** y **Lista**. En la lista están el buscador (placa, marca, proveedor o conductor), los filtros de flota y de tipo de servicio, y todas las unidades ordenadas de lo más urgente a lo menos. **Toca una unidad** y la pantalla vuelve al mapa, la centra y abre su ficha con el botón para **llamar al conductor**.\n\nLos contadores de colores quedan siempre a la vista, debajo de Mapa y Lista, y también filtran. La leyenda de colores se abre con el botón **ⓘ** de la esquina del mapa.",
      },
      {
        pregunta: "Llegó una alerta SOS. ¿Qué pasa cuando la marco como atendida?",
        respuesta:
          "El SOS lo dispara el conductor desde su app y entra **en tiempo real**, sin esperar refresco: aparece el botón rojo arriba y la unidad se pinta de rojo en el mapa, con su posición al momento de la alerta.\n\nPulsar **Atendido** solo registra que alguien de la oficina se hizo cargo: quién y cuándo. **No resuelve nada por sí solo** — la llamada al conductor la tienes que hacer tú.\n\nSi el hecho fue serio (accidente, robo, unidad detenida), regístralo además en **Incidencias**, que es donde queda el expediente con su plazo de atención, su responsable y su acción correctiva.",
      },
      {
        pregunta: "En “Salud del rastreo” un conductor sale al 38 %. ¿Me está engañando?",
        respuesta:
          "Lo más probable es que **no**. La columna **Cobertura** mide cuánto del viaje quedó rastreado, y un valor así es la firma clásica de un teléfono mal configurado, no de un conductor haciendo trampa:\n\n• el permiso de ubicación en **“Solo mientras se usa la app”** en vez de “Permitir siempre”, o\n• el **ahorro de batería** del fabricante matando la app en segundo plano.\n\nLa pantalla te lo clasifica sola: **Completo** de 95 % para arriba, **Aceptable** desde 90, **Con cortes** desde 70 e **Incompleto** por debajo. Son las mismas bandas y el mismo cálculo de la columna **Rastreo** de Seguimiento. Los equipos bien configurados dan 100 %, y los que tienen el permiso mal puesto rondan justo ese 35-40 %. Por eso la solución es configurarle el equipo, no llamarle la atención.\n\n**La excepción sí es grave:** si aparece el aviso rojo de **“Ubicación simulada detectada”**, esos puntos los generó una app de GPS falso, no el teléfono. Ahí sí hay que verificar el equipo antes de sacar conclusiones.",
      },
      {
        pregunta: "¿Para qué me sirve saber los “kilómetros a ciegas”?",
        respuesta:
          "Son los kilómetros del servicio que ocurrieron **sin ningún punto GPS**: tramos que no puedes probar.\n\nImporta por dos razones muy concretas. La primera es el cliente corporativo que te pide sustento del recorrido: si un tercio del viaje no tiene traza, no tienes con qué respaldarlo. La segunda es interna: sin traza tampoco puedes contrastar el kilometraje declarado ni la hora real de salida, que es justo lo que alimenta la liquidación.\n\nPuedes medir los últimos **3, 7 o 15 días**. Empieza por los cortos: con 15 días la medición a veces se pasa del tiempo límite, y la pantalla te lo dice con esas palabras y te pide que uses menos días.",
      },
    ],
    relacionadas: [
      { etiqueta: "Seguimiento operativo", href: "/seguimiento" },
      { etiqueta: "Seguridad vial (excesos de velocidad)", href: "/seguridad-vial" },
      { etiqueta: "Incidencias", href: "/incidencias" },
      { etiqueta: "Conductores", href: "/conductores" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SEGURIDAD VIAL · EXCESOS DE VELOCIDAD
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "seguridad-vial",
    rutas: ["/seguridad-vial"],
    titulo: "Seguridad vial · excesos de velocidad sostenidos y comprobados",
    resumen:
      "Quién manejó por encima del límite, cuánto tiempo y en qué servicio. Solo cuenta un exceso **sostenido** (al menos 30 segundos) y **confirmado por las posiciones** del GPS: un pico suelto o la velocidad fantasma de un teléfono con el bus detenido no acusan a nadie.",
    paraQueSirve: [
      "Ver qué conductores y qué unidades tuvieron excesos en un periodo, con el tiempo total, el pico y la velocidad sostenida.",
      "Comparar con justicia: el ranking cuenta servicios con exceso sobre servicios prestados, no excesos sueltos.",
      "Revisar un servicio concreto desde su ficha en Seguimiento (enlace «🚦 Excesos»).",
      "Saber a qué conductores no se les puede medir, porque su teléfono no reporta la velocidad.",
    ],
    conceptos: ["exceso_sostenido"],
    faqs: [
      {
        pregunta: "Un conductor sale sin excesos. ¿Quiere decir que maneja bien?",
        respuesta:
          "No necesariamente, y la pantalla lo separa con cuidado.\n\nLa velocidad la mide **el teléfono del conductor**, no el bus. Hay teléfonos —sobre todo los que usan la app desde el navegador— que **no reportan la velocidad del sensor**: mandan siempre 0. Ese conductor no puede tener excesos aunque vaya a 120, así que **no sale como «0 excesos»**: sale como **«Sin velocímetro: no se puede juzgar»**. Decir cero sería afirmar algo que nadie midió.\n\nLo mismo con **«Sin GPS en el periodo»** (no mandó ninguna posición) y **«No se pudo comprobar»** (la consulta falló).\n\nY aun con velocímetro, «sin excesos» quiere decir eso y nada más: que no pasó del umbral elegido de forma sostenida. No mide frenadas, curvas ni la distancia con el vehículo de adelante.\n\nLos teléfonos sin velocímetro se revisan en **Salud del GPS**: el aviso gris de la pantalla trae el enlace.",
      },
      {
        pregunta: "¿Por qué el umbral es 90 km/h?",
        respuesta:
          "Es el **límite habitual para buses de pasajeros en carretera** según el Reglamento Nacional de Tránsito, y es solo el valor con el que abre la pantalla: lo cambias en **Umbral**, de 60 a 130 km/h.\n\nNo se cita el artículo exacto porque no se pudo cotejar con el texto oficial vigente, y un número de artículo mal puesto en una pantalla que sirve para llamarle la atención a alguien es peor que no ponerlo.",
      },
      {
        pregunta: "¿Por qué no veo un exceso de 70 km/h dentro de la ciudad?",
        respuesta:
          "Porque el ERP juzga con **un solo umbral para toda vía**. El GPS dice dónde está el bus, no cuál es el límite de esa calle, así que no distingue una avenida de una vía expresa o de la Panamericana.\n\nCon 90, un bus a 70 en una zona de 50 no aparece, y un paseo escolar se juzga igual que un viaje interprovincial.\n\nPara revisar la ciudad, **baja el umbral** (a 60 o 65) y mira qué servicios aparecen: lo que salga en una ruta urbana es justo lo que estás buscando. No baja de 60 porque la búsqueda rápida de la base solo mira los puntos desde esa velocidad.",
      },
      {
        pregunta: "¿Qué es «sin corroborar» y los demás descartados?",
        respuesta:
          "Antes de contar un exceso, el ERP lo pasa por cinco filtros, en este orden, y el primero que falla lo descarta. Los descartados **no se esconden**: van en su propia lista, «Descartados: no cuentan como exceso», cada uno con su motivo.\n\n• **GPS simulado** — alguna posición vino de una app de ubicación falsa. No se juzga; se revisa en Salud del GPS.\n• **Velocidad imposible** — el sensor o las posiciones pasan de 130 km/h. Eso no es un bus, es un error del GPS.\n• **Pico breve** — duró menos de 30 segundos o tuvo menos de 3 lecturas. No alcanza para decir que manejó así.\n• **GPS impreciso** — la precisión de las posiciones fue peor que 20 metros, o no se conoce: no pueden confirmar nada.\n• **Sin corroborar** (en pantalla, «Las posiciones no lo confirman») — el sensor marcó la velocidad, pero midiendo la distancia entre posiciones el bus avanzó a menos del 90 % del umbral. Es la firma de la **velocidad fantasma**: hay teléfonos que reportan velocidad con el bus detenido en un paradero.\n\nEsa distancia entre posiciones se mide en línea recta, y una curva siempre es más larga que su recta: por eso la comprobación **nunca acusa de más**.\n\nSolo lo que pasa los cinco filtros cuenta como **exceso**.",
      },
      {
        pregunta: "¿Por qué lo que pasa fuera de servicio no cuenta?",
        respuesta:
          "Una posición fuera de servicio es la app abierta **sin ningún servicio iniciado**. Nada prueba que el teléfono iba en el bus: puede ser el conductor volviendo a su casa en su propio auto.\n\nPor eso esos excesos **no suman al ranking** de nadie. Si marcas **«Incluir fuera de servicio»** se listan aparte, para que los veas, pero con el lugar **aproximado a un kilómetro**: la ubicación exacta de la casa de alguien no le sirve a la seguridad vial de la flota.",
      },
      {
        pregunta: "Me sale un aviso ámbar de que falta correr una migración. ¿Qué hago?",
        respuesta:
          "La pantalla necesita dos funciones en la base de datos, que se crean con **supabase/gps-analitica-01a-puntos-rapidos.sql** y **supabase/gps-analitica-01b-velocimetro.sql**. El despliegue no las crea solo: alguien con acceso a Supabase tiene que pegar cada archivo **entero** en el editor SQL y correrlo, una vez.\n\nMientras tanto la pantalla **no muestra ningún número** —unas listas vacías se leerían como «0 excesos», que sería falso— y lo dice en ámbar. Los excesos de un servicio sí se ven en **Uso de flota → Servicios**, que lee el recorrido completo de cada servicio.\n\nEl tercer archivo, **supabase/gps-analitica-01c-indices.sql**, crea el índice que hace rápida la lectura. Mientras lo construye frena el registro del GPS de los conductores unos segundos: córrelo en hora valle.",
      },
      {
        pregunta: "¿Por qué el umbral solo va de 5 en 5?",
        respuesta:
          "Porque cada medición lee las posiciones rápidas de **toda la flota** en el rango, y el resultado se guarda un rato para no repetir ese trabajo. Si el umbral aceptara cualquier número, bastaría con cambiarlo de 90 a 91, 92, 93… para obligar a releerlo todo cada vez y saturar el servidor.\n\nCon pasos de 5 hay 15 valores posibles (60, 65 … 130), más precisión de la que da el GPS de un teléfono. Uso de flota → Servicios acepta exactamente los mismos.",
      },
      {
        pregunta: "¿Hasta cuándo puedo mirar para atrás, y por qué tarda?",
        respuesta:
          "Se puede medir hasta **90 días atrás** y como mucho **31 días a la vez**. Un mes se mide en tandas de 7 días, una detrás de otra —verás «Midiendo 2/5…»— y al final se juntan en un solo ranking.\n\nMientras mide, la pantalla no enseña el resultado del rango anterior: se leería como si fuera el nuevo.",
      },
      {
        pregunta: "¿Dónde fue el exceso? ¿Cómo lo veo en el mapa?",
        respuesta:
          "Pulsa **«Ver recorrido ↗»** al lado del exceso. Se abre el mapa del servicio con el **recorrido real que marcó el GPS**, igual que el modal GPS de Seguimiento: la línea va **coloreada por velocidad** (Parado, Lento, Moderado, Rápido) y, encima de todo, **en rojo con borde blanco**, el tramo donde se pasó del umbral, con una etiqueta con su velocidad. El mapa llega ya centrado en ESE exceso, y a la derecha está la lista de todos los del servicio: tocando uno, el mapa va a él.\n\nCada exceso puede llevar una **etiqueta de dónde ocurrió**, por ejemplo «antes del paradero 1 · sin pasajeros». Es solo informativa: el exceso **cuenta igual** (también puede traer una multa). Si no hay datos para afirmarlo, no sale ninguna etiqueta.\n\nEl mapa usa el **mismo umbral** que tenías puesto en esta pantalla, y los excesos que pinta son exactamente los que cuenta la columna «Excesos» de Uso de flota.\n\n**Donde no llegó señal no se dibuja ninguna línea**: el mapa no inventa por dónde fue el bus. Esos tramos se marcan con un **punto gris** en la última posición antes del corte y en la primera después, y son **los mismos que cuenta la celda RASTREO** de Seguimiento (el bloque «Rastreo GPS» de la derecha los lista y, al tocarlos, el mapa va a ellos). Si la **ruta prevista** del servicio ya está guardada (se guarda al abrir el modal GPS), el hueco se rellena con un **tramo estimado en verde petróleo** sobre esa ruta; si no está guardada, solo quedan los dos puntos.\n\nEs un mapa de **Mapbox**, el mismo de toda la operación: abrirlo no consulta ninguna ruta a Google ni a ningún otro servicio de pago. Por eso el trazo une las posiciones GPS tal como llegaron y no se ajusta a la vía.",
      },
    ],
    relacionadas: [
      { etiqueta: "Salud del GPS (teléfonos sin velocímetro)", href: "/gps-salud" },
      { etiqueta: "Uso de flota · estadística por servicio", href: "/uso-flota?tab=servicios" },
      { etiqueta: "Seguimiento operativo", href: "/seguimiento" },
      { etiqueta: "Conductores", href: "/conductores" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PASAJEROS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "pasajeros",
    rutas: ["/pasajeros"],
    titulo: "Pasajeros · la nómina que transportas",
    resumen:
      "Es el padrón de las personas que viajan: nombre, documento, empresa a la que pertenecen y cómo contactarlas. De aquí salen los manifiestos, los avisos de horario y el QR con el que suben al bus.",
    paraQueSirve: [
      "Tener una sola lista limpia de pasajeros por empresa cliente.",
      "Generar el QR de embarque de cada persona.",
      "Asignar quién sube en cada paradero de un servicio.",
      "Cargar de golpe la nómina que te manda el cliente, sin teclear uno por uno.",
    ],
    faqs: [
      {
        pregunta: "¿Para qué sirve el QR de cada pasajero?",
        respuesta:
          "Para el **abordaje**: el conductor lo escanea desde su app y queda registrado quién subió, en qué paradero y a qué hora — con la hora del servidor, no la del teléfono.\n\nEso te da tres cosas que antes no tenías: el conteo real de abordados contra el manifiesto (lo ves en Seguimiento), la prueba de que la persona viajó, y una de las evidencias con las que el ERP deduce la hora real de salida del servicio.\n\nEl QR se genera solo al registrar al pasajero. Si dice “QR aún no generado”, es que todavía no guardaste la ficha.",
      },
      {
        pregunta: "Registré al pasajero pero no aparece en el manifiesto del servicio. ¿Por qué?",
        respuesta:
          "Porque estar en el padrón y estar en un servicio son dos cosas distintas. El padrón dice *quién existe*; el manifiesto dice *quién viaja mañana y en qué paradero sube*.\n\nUsa el bloque **“Asignar pasajeros a paradas”** al final de esta pantalla: eliges la reserva, eliges la parada, marcas a las personas que suben ahí y guardas. También puedes hacerlo desde el propio **Manifiesto** en Programación.\n\nY recuerda el paso que casi todos olvidan: después de armar el manifiesto hay que **sincronizarlo** para que llegue al conductor y a los pasajeros.",
      },
      {
        pregunta: "El cliente me mandó su nómina en una lista. ¿Tengo que teclearla?",
        respuesta:
          "No. Pulsa **Importar lista**, elige la empresa y pega los nombres, uno por línea. Acepta también documento, correo y teléfono separados por comas:\n\n*Juan Pérez García, 12345678, juan@empresa.pe, 987654321*\n\nCon el nombre solo basta, pero **sin correo ni teléfono ese pasajero no recibirá ningún aviso** de horario ni de cambio de hora: quedará registrado como “sin canal”. Si el cliente te va a pedir que sus trabajadores estén informados, pide los contactos desde el principio.\n\nAntes de importar puedes marcar que se envíe la invitación automática a los nuevos.",
      },
    ],
    relacionadas: [
      { etiqueta: "Programación · manifiesto", href: "/programacion" },
      { etiqueta: "Comunicados", href: "/comunicados" },
      { etiqueta: "Clientes", href: "/clientes" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // COMUNICADOS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "comunicados",
    rutas: ["/comunicados"],
    titulo: "Comunicados · avisar a todos los pasajeros de un cliente",
    resumen:
      "Es el envío masivo a los pasajeros de una empresa cliente: cambios de horario, nuevos paraderos, avisos de feriado. Se manda por correo, por WhatsApp o por ambos.",
    paraQueSirve: [
      "Mandar un mismo aviso a toda la nómina de un cliente de una sola vez.",
      "Adjuntar el cuadro de horarios o el mapa de paraderos en PDF o imagen.",
      "Saber a cuánta gente va a llegar antes de enviarlo.",
      "Probar el mensaje contigo mismo antes de contactar a nadie.",
    ],
    faqs: [
      {
        pregunta: "¿Esto es lo mismo que los avisos que ya reciben los pasajeros?",
        respuesta:
          "No. Son dos cosas distintas:\n\n• Los **avisos automáticos** del servicio (“mañana pasan por ti a las 05:40”) salen solos cuando sincronizas el manifiesto en Programación o cuando corre el recordatorio del día anterior. No los redactas tú.\n• **Comunicados** es lo que escribes tú y va a **toda la nómina de la empresa**, no a los pasajeros de un servicio: el cuadro de horarios del mes, un cambio de paradero, un aviso por feriado.\n\nRegla simple: si es de un viaje, es automático; si es del contrato, es un comunicado.",
      },
      {
        pregunta: "El correo salió y el WhatsApp no. ¿Está roto?",
        respuesta:
          "No, y la propia pantalla te lo avisa arriba en azul. El **correo funciona de inmediato**. El **WhatsApp** sale del número de avisos como un documento PDF, y para eso Meta exige una **plantilla aprobada** con encabezado de documento.\n\nMientras Meta no la apruebe, usa solo el canal correo. No es algo que se arregle desde el ERP: depende de la aprobación de Meta.\n\nOtra cosa que confunde: para enviar por WhatsApp **es obligatorio adjuntar** al menos una imagen o un PDF, porque el mensaje viaja como documento.",
      },
      {
        pregunta: "¿Cómo sé a cuánta gente le va a llegar antes de mandarlo?",
        respuesta:
          "Al elegir la empresa, abajo del formulario aparece la **audiencia**: cuántos pasajeros son, cuántos tienen teléfono y cuántos tienen correo. Ese conteo es real, no una estimación.\n\nY al pulsar enviar te vuelve a preguntar con el número exacto (“se enviará a 48 pasajeros: 31 por WhatsApp y 44 por correo”), porque **esto contacta a gente de verdad**.\n\nUsa siempre antes el botón de **probar** con tu propio correo o número: así ves exactamente lo que va a recibir el pasajero. El comunicado nace como **borrador** justamente para que puedas revisarlo con calma; si te arrepientes a mitad de envío, puedes **cancelarlo** y los pendientes no se mandan.",
      },
    ],
    relacionadas: [
      { etiqueta: "Pasajeros", href: "/pasajeros" },
      { etiqueta: "Clientes", href: "/clientes" },
      { etiqueta: "Programación · manifiesto", href: "/programacion" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // INCIDENCIAS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "incidencias",
    rutas: ["/incidencias"],
    titulo: "Incidencias · cuando algo sale mal",
    resumen:
      "Es el expediente de todo lo que se sale del guion: un choque, una falla mecánica, un robo, un retraso grave, una queja del cliente. Cada caso tiene severidad, responsable, plazo de atención y acción correctiva.",
    paraQueSirve: [
      "Que un problema no se quede en un mensaje de WhatsApp que nadie vuelve a leer.",
      "Saber quién está a cargo de resolverlo y cuánto tiempo lleva abierto.",
      "Activar el protocolo de SOAT cuando hay un siniestro y guardar el número de expediente.",
      "Ver qué unidades y qué conductores acumulan más incidencias.",
    ],
    conceptos: ["conformidad"],
    faqs: [
      {
        pregunta: "¿Qué va aquí y qué va en Multas?",
        respuesta:
          "**Multas** es solo para papeletas: SAT, SUTRAN, MTC, municipalidad. Tienen su propio circuito porque tienen pronto pago, puntos y vencimiento legal.\n\n**Incidencias** es todo lo demás que interrumpe o daña el servicio: accidente, atropello, robo, falla mecánica, unidad detenida, falta de conductor, retraso operativo, desvío de ruta, daño estético, limpieza o climatización.\n\nUna papeleta que además paró el servicio puede estar en los dos sitios: la papeleta en Multas (para pagarla a tiempo) y el hecho en Incidencias (para explicárselo al cliente y corregir la causa).",
      },
      {
        pregunta: "¿Qué es el SLA y por qué mi incidencia sale en rojo?",
        respuesta:
          "El **SLA** es el plazo en horas que te diste para atender ese caso. La pantalla te muestra “horas transcurridas / horas de plazo” y lo pinta:\n\n• **verde** — en tiempo,\n• **naranja** — pasaste el 75 % del plazo,\n• **rojo** — vencido.\n\nRojo no significa que el problema empeoró: significa que **lleva demasiado tiempo sin que nadie lo cierre**. Casi siempre el caso ya se resolvió en la calle y lo que falta es escribir la acción correctiva y pasarlo a *Cerrado*.\n\nEl recorrido es: Reportado → En gestión → Descargo / Legal → Cerrado. La vista Kanban es la más cómoda para moverlas.",
      },
      {
        pregunta: "¿Qué hacen los interruptores de “Requiere reemplazo” y “Activar SOAT”?",
        respuesta:
          "Son dos marcas que cambian cómo se trata el caso:\n\n• **Requiere reemplazo** — avisa que hay que mandar otra unidad. El servicio no se puede quedar tirado mientras se investiga qué pasó.\n• **Activar SOAT** — abre el expediente del siniestro y habilita el campo del **número de siniestro** de la aseguradora. Úsalo en cuanto haya lesionados o daños a terceros: los plazos del seguro son cortos y se cuentan desde el hecho.\n\nEl campo **Impacto económico** es tu estimación de lo que costó el problema (la grúa, el día de servicio caído, el descuento al cliente). No se contabiliza solo: si ese dinero salió de verdad, hay que registrarlo además en **Gastos** o en la caja chica de quien lo pagó.",
      },
    ],
    relacionadas: [
      { etiqueta: "Multas e infracciones", href: "/multas" },
      { etiqueta: "Monitoreo GPS · alertas SOS", href: "/monitoreo" },
      { etiqueta: "Mantenimiento", href: "/mantenimiento" },
      { etiqueta: "Gastos", href: "/gastos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MULTAS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "multas",
    rutas: ["/multas"],
    titulo: "Multas e infracciones · papeletas y puntos",
    resumen:
      "Es el control de las papeletas de la flota: cuánto debes, cuáles todavía tienen descuento por pronto pago y qué conductores se están acercando al límite de puntos que les suspende la licencia.",
    paraQueSirve: [
      "No perder el descuento por pagar tarde una papeleta que ya tenías registrada.",
      "Saber cuánto tienes pendiente en multas y cuánto podrías ahorrar pagando ahora.",
      "Vigilar los puntos acumulados por conductor antes de que le suspendan la licencia.",
      "Tener a la mano el número de papeleta y la entidad cuando toca reclamar o impugnar.",
    ],
    conceptos: ["saldo", "vencimiento"],
    faqs: [
      {
        pregunta: "¿Qué es el “pronto pago” y por qué el ERP me propone un monto menor?",
        respuesta:
          "Las entidades dan un descuento si pagas dentro de los primeros días. Al registrar la papeleta, el ERP calcula la fecha límite y el monto rebajado, y el bloque ámbar de arriba te muestra cuánto te ahorras si pagas ya.\n\n**Sé consciente de esto: los plazos y porcentajes que trae el sistema son valores de referencia** (por ejemplo 50 % en SAT Lima a 7 días, 20 % en SUTRAN a 15). Las entidades los cambian, y varían según el tipo de infracción.\n\n**El que manda es lo que dice la papeleta o el portal de la entidad**, no el ERP. Si no coinciden, sobrescribe el monto y la fecha a mano y hazle caso al documento.",
      },
      {
        pregunta: "¿Qué son los puntos y qué pasa cuando un conductor llega a 100?",
        respuesta:
          "Cada infracción suma puntos al **récord del conductor**, no al del vehículo. Al acumular **100 puntos** viene la suspensión de la licencia por parte de la autoridad — y un conductor suspendido es un bus que no sale.\n\nEl panel **“Riesgo por conductor”** te muestra la barra de los **seis conductores con más puntos**. A partir de **40 puntos** aparece “En observación”; a partir de **70** se pinta en rojo con el aviso **“RIESGO ALTO — evitar asignar”**.\n\nEsto es información para decidir a quién le das el servicio del cliente exigente, y para saber a quién toca capacitar antes de que te quedes sin chofer. Si te importa un conductor que no está entre esos seis, búscalo en el listado de papeletas.",
      },
      {
        pregunta: "La multa fue por culpa del conductor. ¿La descuento de su sueldo?",
        respuesta:
          "Eso **no lo decide el ERP**: depende de tu contrato y de lo que permita la legislación laboral, y conviene confirmarlo con tu contador o tu asesor laboral antes de descontar nada de una planilla.\n\nLo que el ERP sí hace es dejar el hecho registrado con nombre, placa, fecha y monto, que es exactamente el sustento que necesitarías para cualquier conversación posterior.\n\nSi decides asumirla como empresa, recuerda que **una multa pagada es dinero que sale del banco**: regístrala también como gasto para que aparezca en tus egresos del mes. Aquí se lleva el control de la papeleta, no el asiento contable.",
      },
      {
        pregunta: "¿Qué significa cada estado de la papeleta?",
        respuesta:
          "• **Pendiente** — registrada y sin pagar. Es la que puede perder el pronto pago.\n• **Pagada** — ya se canceló; guarda la fecha y el monto que pagaste de verdad, que puede ser el rebajado.\n• **Impugnada** — presentaste descargo y estás esperando respuesta.\n• **En proceso** — trámite en curso (fraccionamiento, verificación).\n• **Vencida** — se pasó la fecha límite. A partir de aquí normalmente crece con intereses y puede terminar en cobranza coactiva.\n\nEl recuadro **Monto pendiente** suma todo lo que no está pagado. Si ese número sube mes a mes, el problema ya no es administrativo: es de conducción.",
      },
    ],
    relacionadas: [
      { etiqueta: "Conductores", href: "/conductores" },
      { etiqueta: "Incidencias", href: "/incidencias" },
      { etiqueta: "Gastos", href: "/gastos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // COTIZACIONES  (+ COTIZADOR)
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "cotizaciones",
    rutas: ["/cotizaciones", "/cotizador"],
    titulo: "Cotizaciones y Cotizador · cómo se pone el precio",
    resumen:
      "Dos pantallas que trabajan juntas. El **Cotizador** calcula cuánto te cuesta de verdad un servicio y qué precio deberías pedir. **Cotizaciones** es donde ese precio se convierte en una propuesta con PDF para el cliente, y de ahí en un servicio programado.",
    paraQueSirve: [
      "Saber si un precio te deja ganancia antes de comprometerte, no después.",
      "Emitir la cotización en PDF con la plantilla que corresponda al tipo de cliente y de servicio (la elige una regla; se puede cambiar).",
      "Llevar el control de qué se cotizó, qué se envió y qué se aprobó.",
      "Convertir una cotización aprobada en un servicio o en un contrato fijo completo.",
      "Registrar y autorizar descuentos dejando constancia de quién los aprobó.",
    ],
    conceptos: ["igv", "margen", "margen_real", "costo_directo", "amortizacion", "factura"],
    faqs: [
      {
        pregunta: "¿Qué es \"sin cotizar (Despachador)\" y cómo lo regularizo?",
        respuesta:
          "Son servicios creados desde el **Despachador** que no tienen una cotización detrás y siguen pendientes (no cancelados ni marcados como que no la requieren). El chip morado de la cabecera los cuenta y **al pulsarlo** abre la lista, con fecha, cliente, RUTA y ORIGEN → DESTINO, aunque sean de días anteriores.\n\nCada uno tiene cuatro salidas:\n\n1. **Crear cotización**: abre el formulario prellenado (cliente, ruta, fecha, hora y el importe sin IGV). Al guardarla, el servicio queda **vinculado** a ella.\n2. **Vincular a cotización existente**: solo a una cotización **eventual del mismo cliente**.\n3. **Cancelar en Programación**: si no se ejecutó. Se cancela allá, porque Programación te pregunta qué hacer con el importe (S/ 0.00 o falso flete).\n4. **No requiere cotización**: con su motivo escrito (cortesía, servicio interno). Se puede deshacer.\n\nSi el chip dice **?**, no se pudo contar: pasa el mouse para ver el error.",
      },
      {
        pregunta: "¿Cómo se llega al precio? Veo tres números distintos.",
        respuesta:
          "Son tres formas de responder la misma pregunta, y el ERP te las enseña juntas para que elijas con criterio:\n\n• **🔧 Cotizador** — el precio calculado desde tus costos reales para esa ruta y esa unidad. Es el que sabe si vas a perder plata.\n• **📋 Tarifario** — el precio oficial que ya tienes fijado para esa ruta. Es el que mantiene la coherencia: que el mismo cliente no reciba dos precios distintos según quién conteste.\n• **⭐ Sugerido** — el **mayor** de los dos anteriores. El ERP no te propone nunca el más barato.\n\nCada uno tiene su botón **Usar**, y abajo queda registrado con qué criterio se fijó el precio (“Modo: cotizador / tarifario / manual”). Ese registro es lo que después te deja explicar por qué un servicio se vendió a S/ 960 y otro parecido a S/ 1,120.",
      },
      {
        pregunta: "⭐ Full Equipo y 📦 Estándar, ¿qué cambian exactamente?",
        respuesta:
          "Son el **nivel de servicio**, y ahora se llaman igual en todo el ERP: en el Cotizador, en la cotización, en el Tarifario y en la ficha de cada vehículo. Antes ese mismo botón decía “Full Equipo / Básico” en unas pantallas y “Premium / Estándar” en otras, que eran **dos nombres para la misma decisión**. Hoy la palabra es una sola y es la comercial, la que AFA usa con el cliente: **Full Equipo**.\n\nAl elegir el nivel pasan tres cosas:\n\n• **Se filtra la lista de unidades.** Con Full Equipo puesto, el selector de “Vehículo de tarifa” solo ofrece las categorías **Full Equipo (menos de 10 años)**; con Estándar, solo las **Estándar (más de 10 años)**. Antes salían las 26 mezcladas y nada impedía cotizar un servicio Full Equipo costeado con una unidad de doce años.\n• **Se busca la tarifa de ese nivel.** El Tarifario guarda un precio por nivel para la misma ruta.\n• **Se imprime en el PDF del cliente**, en el ANEXO 1, junto a la descripción y las fotos de la unidad.\n\nDos detalles que evitan sustos:\n\n**Cambiar de nivel no te borra la unidad**: si tenías el Sprinter 17 Full Equipo y pasas a Estándar, se cambia sola a la Sprinter 17 Estándar — la misma capacidad, el otro nivel. Solo si esa categoría **no existe** en el otro nivel se suelta la selección, y la pantalla te dice cuál falta en vez de dejarte el recuadro vacío.\n\n**El comparativo de abajo sigue mostrando los dos niveles**, a propósito: es el único sitio donde ves la diferencia de precio entre una gemela y otra. Si haces clic en una fila del otro nivel, el botón de arriba la sigue.\n\nY si la **unidad de flota** que elegiste está marcada con otro nivel del que estás cotizando, sale un aviso ámbar: el PDF imprime la descripción de esa placa, así que venderías “Full Equipo” con un anexo que dice “cumple ley”. Con unidades **tercerizadas** no sale nunca — de esas el ERP no tiene registrado el equipamiento, y prefiere callarse antes que inventarlo.",
      },
      {
        pregunta: "¿Qué mete el Cotizador dentro del costo?",
        respuesta:
          "Todo lo que gasta el bus por kilómetro, no solo la gasolina. El bloque **Desglose de costos** es literalmente la cuenta:\n\n• **Combustible** (con su rendimiento real, y la UREA aparte si la unidad la usa),\n• **Neumáticos**, repartidos por kilómetro según lo que duran,\n• **Mantenimiento** por kilómetro — **todo** el del taller, preventivo y correctivo, no solo el programado; la tarifa en S/ por km sale entre paréntesis,\n• **Depreciación** — lo que el bus pierde de valor rodando,\n• **Seguros, SOAT, permisos** — ahí dentro va también la revisión técnica, repartido por kilómetro en un recorrido urbano y por día en carretera,\n• **Reserva (5 %)** para lo imprevisto,\n• **Conductor** por día, más **peajes y otros**.\n\nEso suma el **costo directo**. Encima se le añade el **Overhead (10 %)** —la oficina: administración, teléfono, alquiler— y, si el viaje los tiene, el **pernocte y los viáticos**. El resultado es la **base de costo completo**, y sobre ella se calculan los tres precios: **Margen mínimo 15 % · Margen objetivo 20 % · Margen alto 25 %**. Son **márgenes**, no clases de bus: la unidad decide el costo, el margen decide el precio.\n\nLos tres cuadros muestran el número grande **SIN IGV** y el importe con IGV debajo, en pequeño. El comparativo de flota va igual: sus columnas (Total 20 %, S/pax, Mín 15 %) son todas sin IGV.\n\nEsos parámetros (rendimiento, precio del combustible, sueldo del conductor, vida del neumático, mantenimiento por km) se editan en **Configuración → Costos**. Si están desactualizados, todo lo que cotices estará mal: revísalos cada vez que suba el combustible.",
      },
      {
        pregunta: "El mantenimiento me sale altísimo, ¿por qué?",
        respuesta:
          "Porque es **una tarifa por kilómetro multiplicada por los km del recorrido**, y esa tarifa la tecleó una persona en la ficha del tipo de vehículo: el ERP no la calcula. La ves entre paréntesis en el renglón. Con **S/ 2.00/km** y una ruta de **210 km** al día salen **S/ 420 diarios**, que en un contrato de 26 días son **S/ 10,920 al mes por un solo bus**. Cuantos más km tiene la ruta, más pesa: el mantenimiento **no** se reparte por día ni siquiera en carretera, porque el desgaste es por kilómetro.\n\nEsa tarifa es **todo** el mantenimiento —preventivo y correctivo—, pero **no** incluye las llantas (tienen su propio renglón) ni el combustible.\n\n**Cómo saber si está bien:**\n• Compárala con el **combustible** del mismo desglose. En un bus en buen estado el taller cuesta bastante menos que el combustible: si el mantenimiento sale **más caro que el combustible**, lo más probable es que la tarifa esté inflada.\n• Haz la cuenta con tu propio gasto: lo que pagaste de taller en un año (repuestos y mano de obra) ÷ los km que recorrió ese bus en ese año. Ese es tu S/ por km real.\n• En **Configuración → Costos → 🚌 Flota / Vehículos**, con la categoría **🔧 Mantenimiento**, la columna **Medido** hace esa misma cuenta con las órdenes de trabajo de **/mantenimiento** y la pone al lado del número tecleado. Necesita órdenes con **kilometraje** y **costo**; con pocas, el número sale como referencia y no se propone.\n\nCorregir la tarifa cambia el costo de **toda** cotización nueva de ese tipo de vehículo. Las cotizaciones ya emitidas no se tocan.",
      },
      {
        pregunta: "¿Por qué a un cliente le sale con IGV y a otro no?",
        respuesta:
          "Porque el ERP lo decide según el tipo de cliente: a una **empresa (B2B)** le propone la cotización **con IGV** y a una **persona (B2C)** sin él. Puedes cambiarlo con el interruptor del formulario; si lo apagas, el PDF sale con la leyenda “No incluye IGV”.\n\nEs una decisión comercial de presentación, no un cambio tributario: el IGV se cobra igual cuando se emite la factura. Lo único que cambia es si el número grande que ve el cliente ya lo incluye o hay que sumárselo aparte.\n\nOjo con esto al comparar precios: el **Tarifario guarda los precios SIN IGV**, y las pantallas se lo suman al mostrarlos. Un precio de tarifario de S/ 949.15 se te muestra como S/ 1,120.\n\nY en el **Cotizador**, el número grande de los tres cuadros es el **sin IGV**; el con IGV va debajo en pequeño. Es a propósito: el IGV **no es tuyo** —lo cobras y se lo entregas a SUNAT—, así que lo que se negocia, lo que sostiene tu margen y lo que hay que comparar contra la competencia es el valor del servicio. Con el número bruto arriba, ese 18 % se lee como parte de tu precio y cada comparación te sale 18 % desviada. Los dos siguen a la vista: el de arriba para decidir, el de abajo para la factura.\n\nLa excepción es el bloque azul **“→ Enviar a Cotizaciones”**: ahí los importes van **con IGV y así lo dicen sus etiquetas**, porque ese es el número que se guarda en la cotización. Si ese bloque mostrara el sin IGV, lo que ves y lo que se guarda serían distintos.",
      },
      {
        pregunta: "¿Puedo cotizar en dólares (US$)?",
        respuesta:
          "Sí. Junto al interruptor del IGV está el selector **Moneda**: **Soles (S/)** o **Dólares (US$)**. Con dólares aparece el campo **Tipo de cambio (S/ por US$)**, y sin un tipo de cambio válido la cotización **no se guarda** (se espera un número entre 2.5 y 6; un 375 sin punto o un 0.27 escrito al revés se rechazan).\n\n**El tipo de cambio queda congelado en la cotización.** El ERP te sugiere uno —el último de la tabla de tipo de cambio o, si no hay, el de tu última cotización en dólares— y te dice de dónde sale, pero el número lo pones tú. Si después el dólar se mueve, la cotización sigue con el suyo.\n\n**Los importes se guardan siempre en soles.** Tú tecleas y ves dólares, pero lo que queda escrito es su equivalente en soles al tipo de cambio de la cotización (US$ × TC). Así la reserva, el programa fijo, el tarifario, la liquidación y los reportes siguen leyendo soles como siempre. Por eso:\n\n• Los indicadores de la lista (totales, tasa) **siguen en soles**.\n• Al convertir en servicio o generar el programa fijo, se escriben **soles al TC de la cotización**, y la pantalla lo dice.\n• En **Facturación**, al elegir una cotización pactada en dólares se te **propone** facturar en US$ con ese tipo de cambio y los ítems convertidos; puedes cambiar la moneda o el TC (el de la factura es el del día de emisión).\n\n**Cambiar de moneda no reinterpreta los números**: los soles guardados se quedan y solo cambia cómo se muestran. Cambiar el tipo de cambio de una cotización en dólares conserva los dólares que tecleaste y recalcula los soles al guardar.\n\nEl PDF en dólares imprime los importes en US$ y **una sola vez** la línea del tipo de cambio referencial; no imprime un total en soles. Las cuentas bancarias que salen son las declaradas en **dólares** y las **sin declarar** (se declaran en **Configuración → Perfil Empresa → Cuentas Bancarias**); una cuenta declarada en soles nunca sale en una cotización en dólares. Si no queda ninguna, el bloque no se imprime y la pantalla te avisa.",
      },
      {
        pregunta: "¿Puedo mandar la cotización en inglés?",
        respuesta:
          "Sí: elige **Idioma del PDF → Inglés**. Se traducen los **textos fijos** del documento: títulos, rótulos de columnas, “Subtotal”, el impuesto (sale como **IGV (Peruvian VAT) 18%** y el RUC como **RUC (Tax ID)**) y las fechas, que salen en formato inglés.\n\n**Lo que escribió una persona NO se traduce**, se imprime tal cual: el asunto, las notas, el itinerario, las condiciones y la descripción de los ítems que tecleaste a mano. Si el cliente lo necesita en inglés, escríbelo en inglés. Dos excepciones, y solo cuando el texto **no se tocó**: las consideraciones que trae el ERP por defecto y la descripción del ítem que compuso el sistema salen en su versión inglesa.\n\n**Los textos libres de la plantilla tampoco salen en inglés** (título del documento, mensaje de cierre, condiciones de la plantilla): están escritos en español, así que en el PDF en inglés no se imprimen y en su lugar van el título en inglés y las consideraciones de la cotización. La pantalla te lo avisa al generar el PDF.\n\nEl idioma es independiente de la moneda: puedes mandar una cotización en inglés y en soles, o en español y en dólares.",
      },
      {
        pregunta: "¿Qué plantilla del PDF usa cada cotización, y de dónde salen sus condiciones?",
        respuesta:
          "**La plantilla es el contenido del PDF** (sus condiciones, sus cuentas, su título y sus colores) y lleva su **diseño** (Corporativo, Moderno con fotos, Turístico o Ejecutivo). Se administran en **Cotizaciones → Plantillas PDF**: para tener otra (por ejemplo, «Turismo particulares») pulsa **Duplicar** sobre la que tenga el diseño que quieres y edita la copia. El editor solo te ofrece lo que ese diseño imprime de verdad (en el Corporativo, por ejemplo, las condiciones y las cuentas: su color y su título son fijos).\n\n**Qué plantilla usa cada cotización lo decide una regla**, en la cuadrícula **«¿Qué plantilla usa cada cotización?»** de esa misma pantalla: tipo de servicio (**Traslado de la IA**, **Eventual**, **Turismo** —full day y multi-día— y **Fijo**) × tipo de cliente (**Empresa** = cliente B2B cotizado en soles, **Particular** = B2C o sin cliente, en soles, **Extranjero** = cotizada en dólares, sea quien sea). Una celda vacía usa la plantilla **principal**.\n\nAl crear la cotización el ERP elige la plantilla por esa regla y la ves en **«Plantilla del PDF»**, junto a las consideraciones; puedes cambiarla. **Las condiciones se copian a la cotización**: lo que ves en Consideraciones es exactamente lo que imprime el PDF, y si después alguien edita la plantilla, las cotizaciones ya guardadas no cambian (queda constancia de lo que se le dijo al cliente).\n\n**Las cotizaciones de antes** imprimen lo mismo que siempre. Al abrir una, Consideraciones te enseña lo que su PDF imprime hoy, así que guardarla no le cambia el PDF. (Antes, si la plantilla tenía condiciones propias, lo que escribías en Consideraciones se guardaba pero no salía en el PDF.)\n\nSi la pantalla dice en ámbar que falta **supabase/cotizaciones-05-plantillas-uso.sql**, todavía no hay reglas ni Duplicar: toda cotización usa la plantilla principal, como antes. Hay que correrlo en Supabase.",
      },
      {
        pregunta: "¿Por qué el PDF trae solo un resumen de la política de reserva y un QR?",
        respuesta:
          "Para no abrumar al cliente: la política de **reserva, cambios y cancelación** completa es larga, y lo que mueve dinero cabe en 4 o 5 puntos (el adelanto, hasta cuándo se cancela sin costo, qué pasa si no se presenta). Si la plantilla tiene un **Resumen de la reserva (con enlace)**, el PDF y el WhatsApp de la IA llevan esos puntos y, debajo, un **enlace con su QR** a las condiciones completas.\n\n**El enlace es de ESA cotización**: abre la política que quedó guardada en ella el día que se emitió, no la de hoy de la plantilla. Si después cambias la política, quien ya recibió su cotización sigue viendo la suya: es la constancia de lo que se le informó antes de pagar. La página no muestra datos del cliente, precios ni cuentas, y no sale en buscadores.\n\n**Nunca se esconde lo que mueve dinero**: sin resumen, o si la cotización no tiene enlace (falta correr el SQL `cotizaciones-08-resumen-condiciones`), el PDF imprime la política entera, como antes. El resumen se escribe en **Cotizaciones → Plantillas PDF → Condiciones** (solo en el diseño Corporativo) y se puede ajustar en cada cotización, debajo de su política. Como la política, no lleva teléfonos, correos, enlaces ni números largos.",
      },
      {
        pregunta: "La lista no me muestra una cotización vieja. ¿Dónde está?",
        respuesta:
          "La lista abre con los **Últimos 90 días** para cargar rápido: no trae de golpe años de cotizaciones. Arriba de la lista están los periodos: **Hoy**, **Últimos 7 días**, **Últimos 30 días**, **Este mes**, **Mes anterior**, **Últimos 90 días**, **Este año**, **Rango de fechas** (eliges desde y hasta) y **Todo**.\n\nAl lado eliges con qué fecha se mide: **Fecha de emisión** (cuándo se creó la cotización) o **Fecha del servicio** (cuándo sale el bus). Con fecha del servicio, las cotizaciones que no tienen esa fecha escrita no aparecen.\n\nEl buscador busca **dentro del periodo elegido**: si no encuentras algo, pulsa **Buscar en todas las fechas** debajo del buscador. Busca por cliente, RUC, ruta, asunto o N°, sin importar tildes ni el orden de las palabras.\n\nLa lista pinta 50 filas; con más, pulsa **Mostrar 50 más** al final. Los indicadores de arriba (Total, Pendientes, Tasa…) cuentan el periodo elegido, y el periodo y los filtros se recuerdan mientras la pestaña siga abierta. **Limpiar filtros** vuelve a los 90 días.",
      },
      {
        pregunta: "¿Cómo encuentro al cliente en el formulario? Son cientos.",
        respuesta:
          "El campo **Cliente** es un buscador 🔍: escribe parte del nombre, la razón social, el RUC, el DNI, el teléfono o la ciudad, en cualquier orden y sin preocuparte de tildes ni mayúsculas. Al entrar al campo sin escribir nada te enseña tus **Recientes** y los **Más cotizados**. Con las flechas te mueves, **Enter** elige y **Esc** deja el cliente que estaba.\n\nLos clientes **bloqueados** no se ofrecen, pero si coinciden con lo que escribiste la lista te lo dice, para que no lo vuelvas a dar de alta.\n\nSi no existe, la última opción es **+ Crear cliente «…»** (o el botón **+**): abre Clientes en otra pestaña con lo que escribiste ya puesto —como RUC o DNI si son 8 u 11 dígitos—. Al guardarlo allá, esta pantalla lo recibe y lo deja elegido solo.\n\nDebajo de **Atención** salen como botones los **contactos** de ese cliente: un clic pone el nombre. No se rellena solo, porque el que firma no siempre es el contacto principal.",
      },
      {
        pregunta: "¿Cómo elijo la unidad propia o tercerizada (la de las fotos del PDF)?",
        respuesta:
          "Los campos **Vehículo propio** y **Vehículo tercerizado** son buscadores 🔍 como el de Cliente: escribe la placa como sea (**BVI124**, **bvi-124**, **BVI 124** o solo **124**), la marca, el modelo, el año, la capacidad (**50**, **50p** o **50 pax**), el nivel (**Full Equipo** / **Estándar**) o, en tercerizados, la **empresa**. Al entrar sin escribir nada salen primero las que **coinciden con el vehículo de tarifa** elegido arriba (chip **✓ tarifa**), luego tus **Recientes** y el resto por placa. El chip **📸** dice que la unidad tiene fotos para el PDF, y un estado como **Ocupado** sale en gris pero se puede elegir igual.\n\nSon excluyentes: elegir una propia quita la tercerizada y al revés. La opción **Sin vehículo…** (o la ✕) deja el campo vacío. El número del rótulo de tercerizados cuenta solo los **activos**.",
      },
      {
        pregunta: "¿Cómo funciona «⏱ Calcular horas» de los paraderos?",
        respuesta:
          "Toma la hora del **paradero 1** (la salida) y le suma, tramo por tramo, lo que tarda el bus por la ruta, más los **minutos de embarque** en cada paradero intermedio (1 por defecto: es un valor de arranque, no medido — si dudas, bájalo, porque una espera de más hace que el pasajero llegue cuando el bus ya pasó). La ida y el retorno tienen cada uno su barra; el retorno sale a su propia hora.\n\nHay **dos modos**, y la diferencia es plata:\n• **Sin tráfico (barato)** — usa la misma ruta que dibuja el mapa. Si el mapa ya la cargó, calcular **no hace ninguna consulta nueva**. Es el propuesto para un servicio **eventual**.\n• **Con tráfico previsto (cuesta más)** — pregunta a Google el tráfico **a la hora en que el bus sale de cada paradero**, una consulta por tramo, en un día de referencia (para un **fijo**, un día hábil típico del contrato; si la fecha no es la del servicio, la pantalla dice que es **supuesta**). Esas consultas cuestan el **doble** y su cuota gratis es la **mitad**, así que antes de gastarlas el ERP te dice cuántas son y cuánto cuestan. Lo ya consultado esa semana a la misma hora sale de caché y no se cobra. Es el propuesto para un servicio **fijo**.\n\n**Qué se pisa:** el botón **Calcular horas** solo llena las horas **vacías** y respeta las que escribiste (las siguientes se calculan desde ellas; si una escrita es imposible de alcanzar, lo avisa en ámbar). **Recalcular todas** las reemplaza todas menos la del paradero 1, y antes te dice **cuántas** horas escritas va a cambiar.\n\n**Las marcas junto a cada hora:** **≈ sin tráfico** o **🚦 previsto** + el día = la calculó el sistema y sigue valiendo. **⚠ desactualizada** = la calculó el sistema pero después moviste, agregaste o quitaste un paradero: usa **Recalcular todas**. Sin marca = la escribió una persona (o la cambiaste a mano después). **(+1)** = cae al día siguiente.\n\nSe publica la hora **probable**, nunca la pesimista: si la hora publicada queda antes de que llegue el bus, el pasajero espera unos minutos; si queda después, lo pierde. Por eso la casilla **Ver llegada en hora punta** solo enseña ese dato aparte y no mueve ninguna hora.",
      },
      {
        pregunta: "¿Para qué sirve el mapa de los paraderos?",
        respuesta:
          "Para ver la ruta real que va a hacer el bus y corregir los paraderos sin teclear coordenadas. Aparece cuando hay al menos dos paraderos con ubicación, y **Ocultar mapa / Ver mapa** lo pliega.\n\n• **Arrastra un número** para mover ese paradero: cambian sus coordenadas y **se conserva el nombre** que tenía (el ERP no lo reescribe solo). Debajo del paradero aparece **↻ Actualizar dirección** por si quieres que Google te proponga el nombre del punto nuevo. Si mueves el **paradero 1** o el **último** de la ida, se mueve también el origen o el destino de la cotización, y el kilometraje se vuelve a calcular.\n• **Haz clic en la línea** y pulsa **＋ Paradero aquí**: se inserta un paradero en ese punto, **entre los dos que lo rodean en el recorrido**, con el nombre que propone Google (cámbialo si no sirve).\n• Las horas que había calculado el sistema quedan marcadas **⚠ desactualizada** en cuanto mueves algo: vuelve a calcularlas.\n\nLa ida y el retorno tienen cada uno su mapa: el retorno **no** es la ida al revés (las calzadas y los sentidos de las vías cambian).",
      },
      {
        pregunta: "El cliente pide descuento. ¿Lo doy y ya?",
        respuesta:
          "Puedes registrarlo, pero **quien lo autoriza es otra persona**, y esa es la gracia del circuito.\n\nEn el bloque **💡 Precios** de la cotización escribes el porcentaje (de 1 a 50) y pulsas **Registrar**. La cotización queda marcada con “🙋 X % pendiente” y en la cabecera de la pantalla aparece el contador de descuentos por autorizar. Quien tenga que aprobarlo pulsa **✅ Autorizar** o lo rechaza con la ✕.\n\nDetalle importante: **fuera del horario de oficina (lunes a viernes, de 8:00 a 18:00, hora de Lima) el ERP no deja autorizar ni aplicar precios a mano.** En su lugar aparece el aviso ámbar *“Fuera de horario L-V 8-18h — precio máximo sugerido automáticamente”*, y al descuento pendiente le sale *“Se responderá en horario de oficina”*.\n\nPor eso, si entras de noche y **no ves los botones “Usar”** debajo de los tres precios, no está roto: es el mismo candado. Vuelve en horario y aparecen.",
      },
      {
        pregunta: "La cotización está aprobada. ¿Y ahora cómo se convierte en servicio?",
        respuesta:
          "Depende del tipo:\n\n• **Servicio eventual** (un traslado puntual): usa el botón verde **→ Res.** de la fila. Crea la reserva con sus paradas, en estado Pendiente. Si la cotización tenía varios vehículos, crea **una reserva por vehículo**, para que cada unidad tenga su propio servicio y su propio costo.\n• **Contrato fijo** (transporte de personal, todos los días): no uses ese botón. Ve a **Programación → “Programa fijo”** y genera desde ahí todas las fechas del contrato de una vez.\n\nEse botón solo funciona con la cotización **aprobada**, y una cotización solo se convierte **una vez**: si ya tiene reserva, el ERP te avisa “Ya fue convertida en reserva” en vez de duplicarla.\n\nY aquí está el cierre del círculo: el margen de la cotización es una **estimación**. El costo de verdad de ese servicio (el combustible que se cargó, los peajes rendidos, la factura del tercero) se ve después en **Gastos → Rentabilidad por servicio**. Comparar los dos, cotización contra realidad, es lo que te dice si tus tarifas están bien puestas.",
      },
    ],
    comoHacer: [
      {
        titulo: "Cotizar un servicio nuevo desde cero",
        pasos: [
          "Entra al Cotizador. Elige el vehículo con el que lo harías: el costo por kilómetro no es el mismo en una van que en un bus.",
          "Arma la ruta con los puntos de Google (origen, paradas, destino). El kilometraje se calcula solo; si no tienes direcciones exactas, puedes poner los km a mano.",
          "Marca si el vehículo regresa al punto de inicio: el retorno también consume combustible y suma kilómetros.",
          "Ajusta las variables del servicio: días de conductor, peajes, pernocte y viáticos si el viaje sale de Lima.",
          "Mira el desglose. Si un número te sorprende (por ejemplo el combustible), el problema está en los parámetros del vehículo, no en la ruta.",
          "Elige el precio: mínimo 15 %, estándar 20 % o premium 25 %.",
          "Pulsa “Enviar a Cotizaciones”. Allí completas cliente, asunto, condiciones y generas el PDF.",
          "Cuando el cliente acepte, pulsa aprobar y anota con qué documento lo hizo (orden de compra, correo, contrato) y su número.",
        ],
        advertencia:
          "El Cotizador calcula con los parámetros de Configuración → Costos. Si el precio del galón sigue en el valor del año pasado, todos tus precios están calculados sobre un costo que ya no existe. Revísalos antes de una campaña de cotizaciones.",
      },
    ],
    relacionadas: [
      { etiqueta: "Tarifario · precios oficiales", href: "/tarifario" },
      { etiqueta: "Programación · generar el contrato", href: "/programacion" },
      { etiqueta: "Gastos · rentabilidad por servicio", href: "/gastos" },
      { etiqueta: "Clientes", href: "/clientes" },
      { etiqueta: "Configuración de costos", href: "/configuracion/costos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TARIFARIO
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "tarifario",
    rutas: ["/tarifario"],
    titulo: "Tarifario · tus precios oficiales por ruta",
    resumen:
      "Es la matriz de precios de la casa: cuánto cuesta cada ruta con cada tipo de unidad. Sirve para que cualquiera en la oficina cotice el mismo precio para el mismo servicio, sin tener que preguntar.",
    paraQueSirve: [
      "Fijar el precio oficial de las rutas que haces siempre.",
      "Ver de un golpe qué rutas todavía no tienen precio fijado.",
      "Separar el precio por evento (eventual) del precio por día (contratos fijos).",
      "Cargar o exportar el tarifario completo en CSV.",
      "Fijar los precios de traslados por zona (aeropuerto ↔ distritos) con los que el agente IA del CRM cotiza por WhatsApp, decidir en qué zonas envía sola la cotización, y probarlo en el simulador.",
      "Poner las fotos (exterior e interior) y la descripción de cada vehículo de traslado que el cliente ve en el PDF de la cotización (las condiciones del PDF se editan en la plantilla del traslado, en Cotizaciones → Plantillas PDF).",
    ],
    conceptos: ["igv", "margen"],
    faqs: [
      {
        pregunta: "¿Qué es «Reserva y pago por la IA» en Zonas y traslados → Ajustes?",
        respuesta:
          "Es lo que deja a la IA del CRM **reservar** un traslado cuando el cliente acepta su cotización por WhatsApp. Nace apagado.\n\n**Adelanto (% del total)**: lo que se le pide pagar para reservar; vacío, no se pide pago y un ejecutivo confirma la unidad primero. **Plazo para confirmar**: los minutos, dentro del horario del equipo, para verificar el pago y confirmar la unidad. **Margen antes del servicio**: si entre esa confirmación y el servicio no queda ese margen, primero se confirma la unidad. **Plazo para devolver**: las horas que se le prometen al devolver (vacío, no se promete un plazo).\n\nEl **correo que recibe los comprobantes** solo lo cambia un administrador del ERP, porque esos correos llevan datos del cliente; los demás lo ven en solo lectura.\n\nDebajo se coteja la política de reserva de cada plantilla PDF con lo que escribes, y «Lo que hace hoy» dice, con lo guardado, si la IA de verdad reserva (agente autónomo, horario del equipo, cuentas).",
      },
      {
        pregunta: "¿En qué se diferencia del Cotizador?",
        respuesta:
          "El **Cotizador** calcula: le das ruta y vehículo y te dice cuánto cuesta y cuánto cobrar. Responde “¿cuánto vale esto?”.\n\nEl **Tarifario** recuerda: es la decisión ya tomada para las rutas que haces siempre. Responde “¿cuánto cobramos nosotros por esto?”.\n\nEn una cotización los verás juntos, y el ERP propone **el mayor de los dos**. Si tu tarifa oficial se quedó corta frente al costo actual, ese contraste es justo la señal de que hay que actualizarla.",
      },
      {
        pregunta: "¡Ojo! ¿Los precios de esta matriz llevan IGV?",
        respuesta:
          "**No. El tarifario guarda los precios SIN IGV.**\n\nEs el error más fácil de cometer aquí. Si tú cobras S/ 1,120 con IGV incluido por esa ruta, lo que va en la celda es **S/ 949.15** (que es 1,120 dividido entre 1.18), no 1,120.\n\nCuando esa tarifa se muestra en una cotización, el ERP le suma el IGV y verás los S/ 1,120. Si cargas el precio con IGV, terminarás cotizando S/ 1,321 sin darte cuenta.",
      },
      {
        pregunta: "Hay celdas ámbar que dicen “ref.”. ¿Qué son?",
        respuesta:
          "Son precios **sacados de una cotización aprobada** para esa ruta y ese vehículo, pero que **nadie ha confirmado como tarifa oficial**. Son una pista, no una decisión.\n\nSirven para no partir de cero: si a ese cliente ya le vendiste esa ruta a S/ 960 y aceptó, ahí está el dato. Cuando decidas que ese es tu precio, **pon el cursor encima de la celda: aparece un ✓ verde en la esquina**. Púlsalo y esa referencia pasa a ser tarifa oficial.\n\nLa barra de **Cobertura** de arriba te dice cuántas rutas tienen tarifa oficial y cuántas siguen solo con referencia. Esa segunda cifra son las rutas donde cada quien improvisa el precio.",
      },
      {
        pregunta: "¿Qué diferencia hay entre el modo EVENTUAL y el FIJO?",
        respuesta:
          "Es lo que significa el número de la celda:\n\n• **EVENTUAL** — precio **total del evento**. Un traslado al aeropuerto: S/ 960 y se acabó.\n• **FIJO** — precio **por día** de un contrato de transporte de personal. Ese mismo número, multiplicado por **26 días**, es lo que le facturarás al mes (el ERP te lo muestra a un costado).\n\nSon dos tarifas distintas para la misma ruta y no se comparan entre sí. Un cliente fijo paga menos por día porque te da volumen y previsibilidad; un eventual paga más porque es una sola vez.\n\nDentro de cada modo puedes además separar por **nivel de servicio**: ⭐ Full Equipo o 📦 Estándar.",
      },
      {
        pregunta: "¿Qué es la vista «Zonas y traslados»?",
        respuesta:
          "Es el tarifario de los **traslados simples** (un punto de recojo y un destino, solo ida o ida y retorno) organizado **por zonas** en vez de por dirección. Es la lista de precios con la que el agente IA del CRM cotiza por WhatsApp, cuando está encendido en **Ajustes**.\n\n• **Zonas**: los 50 distritos de Lima y Callao agrupados por sector, más **puntos** como el aeropuerto (una geocerca: dentro de su radio manda sobre el distrito). Los distritos grandes —SJL, Ancón, Ventanilla, Lurín, Lurigancho— se parten en **subzonas** marcando su centro en el mapa: una dirección cae en la subzona más cercana, o en la que nombre su barrio.\n• **Precios**: por **par de zonas** (aeropuerto ↔ Miraflores vale igual en los dos sentidos), por vehículo y en dos monedas: **soles** para números peruanos (+51) y **dólares** (precio turista) para el resto — o para el cliente que **pide la cotización en dólares**, aunque escriba desde un número peruano (la IA solo lo aplica si el cliente escribió «dólares», «USD» o «$»). Pedir soles desde un número extranjero, u otra moneda, lo ve un ejecutivo. Son **netos por tramo, sin IGV**; ida y retorno son dos tramos. Una subzona sin precio propio usa el de su distrito.\n• **Vehículos**: se elige el **más chico donde caben**. Sin bodega, cada maleta de 23 kg ocupa un asiento (10 pasajeros con maletas → Sprinter 20); el minibús lleva hasta 15 maletas en su maletera y el bus 45 en sus bodegas.\n• **Simulador**: escribe un pedido y ves exactamente qué haría la IA: cotizarlo, preguntarle algo al cliente, o pasarlo a un ejecutivo, con el porqué. Si lo cotiza, te dice además si el PDF **saldría solo** o quedaría **en revisión**, y **Ver PDF de ejemplo** te enseña el PDF que recibiría el cliente (con el número «EJEMPLO»: no se guarda ni se envía nada), y de qué **plantilla** salen sus condiciones.\n• **Ajustes**: la validez, la espera gratis, el tipo de cambio y los dos interruptores de la IA (**🤖 Cotización automática por WhatsApp**). Las condiciones del PDF (consideraciones, Incluye y No incluye) se **enseñan** por tipo de cliente con la plantilla de la que salen, y se editan en esa plantilla (**Cotizaciones → Plantillas PDF**); si la espera gratis no coincide con los minutos que dice una plantilla, te nombra cuál corregir. Mientras no se corra **supabase/cotizaciones-05-plantillas-uso.sql**, se editan aquí, como antes; y si algún tipo de cliente no tiene una plantilla que la IA pueda usar, sus listas siguen saliendo de aquí y se editan aquí (un aviso ámbar dice cuáles).",
      },
      {
        pregunta: "¿La IA del CRM ya cotiza traslados sola?",
        respuesta:
          "**Sí, si la enciendes**, y solo los **traslados simples**: un recojo y un destino, solo ida o ida y retorno. En **Zonas y traslados → Ajustes**, el bloque **🤖 Cotización automática por WhatsApp** tiene dos casillas:\n\n• **La IA cotiza traslados**: la IA del CRM calcula el precio con este tarifario (el precio **nunca** lo pone ella), crea la cotización en **Cotizaciones** y le contesta al cliente por WhatsApp.\n• **Enviar sola la cotización en las zonas marcadas**: si el recojo o el destino está en una zona con **📄 Envío automático de la cotización** (en AFA, por ahora y como prueba, solo el **aeropuerto**), el PDF le llega al cliente **sin revisión**. Las demás quedan en el **inbox del CRM** como **🚐 Cotización de traslado para revisar**, y un ejecutivo la envía con un clic.\n\nLo que la IA **no** cotiza —TDR, licitaciones, eventos, varios servicios, descuentos, que el vehículo quede a disposición— pasa a un ejecutivo. Y **la disponibilidad de la unidad y la reserva las confirma siempre un ejecutivo**: el PDF lo dice.\n\nDepende además del **agente IA del CRM** (CRM → Agente IA): tiene que estar **activo**, atender **WhatsApp** y estar en modo **autónomo** para WhatsApp. En modo copiloto todo lo que cotice queda en revisión, y si el agente tiene horario, fuera de él no responde. El bloque de Ajustes te dice en una línea lo que está haciendo hoy, y en ámbar si algo contradice lo que parece (por ejemplo, el envío encendido sin ninguna zona marcada).\n\nSi el bloque dice que falta **supabase/traslados-05-cotizacion-ia.sql**, la IA no cotiza traslados hasta que alguien lo corra en Supabase.",
      },
      {
        pregunta: "¿Qué PDF le llega al cliente cuando cotiza la IA?",
        respuesta:
          "**La cotización corporativa**: la misma plantilla que usas en **Cotizaciones** (cabecera azul con tu logo, datos del cliente, detalle del servicio, tabla de ítems con los totales, cuentas bancarias y, en la segunda hoja, la descripción de la unidad con sus fotos y las condiciones). No es un formato aparte.\n\nLo que cambia frente a una cotización hecha a mano, a propósito:\n\n• **Las condiciones son las de la plantilla del traslado**: la que diga la regla **Traslado de la IA** para ese tipo de cliente en **Cotizaciones → Plantillas PDF**. Se copian a la cotización al crearla: cambiar la plantilla después no reescribe lo que ya se envió. Mientras no se corra **supabase/cotizaciones-05-plantillas-uso.sql**, son las de **Ajustes** (consideraciones e Incluye / No incluye). Una lista vacía no se imprime.\n• **La validez se dice como es**: vale los días de Ajustes o hasta la fecha del servicio, lo que llegue primero, y si es antes de 30 días dice «Válida hasta el …».\n• **El vehículo se describe con la categoría**: su descripción para el cliente o, sin ella, «{nombre} para hasta N pasajeros · bodega para M maletas de 23 kg». Nunca «A/C» ni nada que nadie escribió.\n• **Las cuentas bancarias son las de esa misma plantilla** (si se desactivó, las de la plantilla **Corporativo**). Si no son las de **Corporativo**, la IA **no la envía sola**: queda para que la revise un ejecutivo, que ve las dos en la nota.\n• Bajo los totales va la línea **«La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo.»**\n\nSi abres esa cotización en **Cotizaciones → 📄 PDF** con una plantilla de diseño **Corporativo** (viene preseleccionada la suya), ves exactamente lo mismo que se envió (siempre en castellano, como el de WhatsApp). Con otro diseño, se imprime como cualquier cotización.",
      },
      {
        pregunta: "¿Dónde cambio las condiciones del PDF de traslado?",
        respuesta:
          "En **Cotizaciones → Plantillas PDF**, en la plantilla que usa el traslado de la IA: la cuadrícula **«¿Qué plantilla usa cada cotización?»**, fila **Traslado de la IA**, te dice cuál es para Empresa, Particular y Extranjero. Al correr **supabase/cotizaciones-05-plantillas-uso.sql** se crean **«Traslados (IA)»** con las condiciones que tenías en Ajustes y, si tenías líneas solo para dólares, **«Traslados (IA) · dólares»**, sin cambiar nada del PDF; desde entonces **Ajustes ya no las edita**: te las enseña y te lleva a la plantilla. Así el mismo texto no vive en dos sitios. La excepción: si para algún tipo de cliente no hay una plantilla que la IA pueda usar, la IA copia las listas de Ajustes, y ahí se siguen editando (en ámbar, diciendo para qué tipos de cliente) hasta que le asignes una.\n\n• La IA solo puede usar una plantilla **activa**, de diseño **Corporativo** y en **castellano**. Si la regla apunta a otra, usa la principal (si sirve) o, si no, las de Ajustes; la cuadrícula lo marca en ámbar.\n• El tipo de cliente sale de la moneda (dólares = Extranjero) y del cliente del ERP **verificado** (vinculado al contacto, o con su mismo número de WhatsApp completo): si no hay uno, es Particular.\n• Lo que cambies vale para las **cotizaciones nuevas**: las ya creadas conservan lo que se les copió.\n• Si en ese momento las plantillas no se pueden leer, la IA no se arriesga a mandar otras condiciones: **pasa el pedido a un ejecutivo**.\n• Ojo con el permiso: en las zonas con envío automático estas condiciones salen **sin revisión**, y las edita quien tiene el módulo **Cotizaciones**. Por eso, aunque la zona tenga envío automático, la cotización **queda para revisión** si una condición trae un **enlace** o un **número de 6 o más dígitos** (un teléfono o una cuenta), si una lista pasa de **30 líneas** o una línea de **500 caracteres** (no cabrían en el PDF), o si las **cuentas bancarias** de la plantilla no son las de **Corporativo**. Las palabras de pago solas («el pago del parqueo…») no la detienen: el editor las marca en ámbar para que las revises.\n\nEl **Simulador** te dice con qué plantilla saldría el PDF.",
      },
      {
        pregunta: "¿Cómo pongo las fotos y la descripción del vehículo que ve el cliente?",
        respuesta:
          "En **Zonas y traslados → Vehículos**, debajo de la tabla, el bloque **📷 Fotos y descripción para la cotización** tiene una tarjeta por vehículo con:\n\n• **Foto exterior y foto interior**: **Subir foto** (o **Cambiar**) desde tu equipo o el celular. La pantalla la achica sola a un JPEG liviano (hasta 1280 px) antes de subirla, así que puedes elegir la foto tal cual salió de la cámara. **Quitar** la retira (las cotizaciones ya enviadas no cambian).\n• **Elegir de la flota**: te sugiere las unidades activas que usan la misma **ficha de costeo** que ese vehículo, con sus fotos. **Usar como exterior / interior** guarda una **copia**: si después cambia la foto de la unidad, la de la cotización no cambia. Las fotos que están en **Google Drive** u otro sitio no se pueden copiar desde aquí: descárgalas y súbelas con **Subir foto**.\n• **Descripción para el cliente** (hasta 300 caracteres). Vacía, el PDF usa la frase por defecto, que la pantalla te enseña tal cual saldrá.\n\n**Ojo con lo que se ve en la foto: el cliente la recibe.** Que no se vea la **placa**, ni el **nombre o el logo de un proveedor**. Sobre todo si la eliges de una unidad **tercerizada**: el cliente nunca debe saber que la unidad no es propia.\n\nLas **fotos HEIC del iPhone** no se pueden convertir en el navegador: elige la foto como JPG o PNG desde la galería (en el iPhone: Ajustes → Cámara → Formatos → «Más compatible») o sube una captura de pantalla.\n\nPara cambiar fotos hace falta el permiso del módulo **Tarifas**. Si el bloque sale en ámbar diciendo que falta **supabase/traslados-07-fotos-categoria.sql**, hay que correrlo en Supabase: hasta entonces el PDF sale sin fotos.",
      },
      {
        pregunta: "¿Cómo marco qué zonas envían sola la cotización?",
        respuesta:
          "En **Zonas y traslados → Zonas**, pulsa **✎ Editar** en la zona y marca **📄 Envío automático de la cotización**. Al guardar te pide confirmación diciendo qué zona es y que esas cotizaciones van a salir **sin revisión**.\n\n• En la lista, la zona lleva el chip **📄 envío automático**. En gris y con «(apagado en Ajustes)» si el interruptor general está apagado: la marca queda guardada, pero por ahora todo sigue en revisión.\n• Una **subzona hereda** la marca de su distrito: si marcas Miraflores, sus subzonas salen solas aunque no las marques, y el chip dice **«hereda de Miraflores»**.\n• Una zona **inactiva** no envía nada aunque esté marcada: el cotizador no la reconoce.\n\nBasta con que **una** de las dos puntas esté marcada: aeropuerto → Miraflores sale solo si el aeropuerto está marcado, y también Miraflores → aeropuerto.",
      },
      {
        pregunta: "¿Por qué el simulador dice «pasa a un ejecutivo» en una dirección que sí conozco?",
        respuesta:
          "Porque **ante la duda el ERP no adivina**: un pedido derivado le cuesta un minuto al ejecutivo; una cotización con el precio de otra zona se descubre cuando el cliente ya la aceptó. Las causas más comunes:\n\n• **Google solo dijo «Lima»**. Lo hace también con direcciones de San Isidro o Lince, así que no se toma como Cercado.\n• **El distrito no se reconoció**: el simulador te muestra el nombre que dio Google; agrégalo como **alias** del distrito en Zonas.\n• **No hay precio** para ese par de zonas y ese vehículo. El ERP **no ofrece un vehículo más grande** solo porque ese sí tiene precio: sería cobrarle al cliente una unidad que no necesita.\n• **No es simple**: paradas intermedias, varias fechas, TDR o licitación, evento, que el vehículo espere, o un pedido de descuento.\n• **Es en dólares y no hay tipo de cambio** de SUNAT de los últimos 7 días (los importes se guardan en soles). Se actualiza solo cada mañana; también hay un botón en Ajustes.\n\nOjo con un caso que el ERP evita a propósito: **«San Juan de Miraflores» contiene la palabra «Miraflores»** y es otro distrito, a 15 km. Por eso las zonas se comparan por el nombre completo, nunca por «contiene».",
      },
      {
        pregunta: "¿Cómo edito los precios de traslado?",
        respuesta:
          "En **Zonas y traslados → Precios** eliges la **zona de origen** (por defecto, la que tiene más precios, casi siempre el aeropuerto) y ves una fila por cada zona con la que tiene precio, con una columna por vehículo y dos casillas: **S/** y **US$**.\n\n• Escribes el número y **se guarda al salir de la casilla**. Si no se pudo guardar, la casilla vuelve a lo que dice la base y un aviso rojo te dice por qué.\n• **Vaciar una casilla borra ese precio.** Nunca se guarda S/ 0.00: un traslado en cero saldría gratis.\n• Las zonas con **exactamente los mismos precios** se juntan en una fila («Miraflores · San Isidro · Barranco»): lo que cambies ahí cambia las tres. Pulsa **▸ separar** para editar una sola.\n• Lo **gris** («usa el de SJL») es el precio que una subzona hereda de su distrito: es el que el cotizador va a usar. Escribe un número para darle uno propio.\n• **＋ Agregar destinos** sirve para cargar de una vez varias zonas con los mismos precios; si alguno ya existía con otro valor, te lo nombra antes de reemplazarlo.\n\nEscribir en esta vista (precios, zonas, vehículos y ajustes) exige el permiso del módulo **Tarifas**: estos precios se le envían al cliente sin que una persona los revise. Si al guardar la pantalla dice que falta, lo da un administrador en **Usuarios**.",
      },
    ],
    relacionadas: [
      { etiqueta: "Cotizador", href: "/cotizador" },
      { etiqueta: "Cotizaciones", href: "/cotizaciones" },
      { etiqueta: "Configuración de costos", href: "/configuracion/costos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CLIENTES
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "clientes",
    rutas: ["/clientes"],
    titulo: "Clientes · con quién trabajas",
    resumen:
      "Es la base comercial: empresas y personas a las que les prestas servicio, con sus contactos, sus condiciones de pago, sus documentos y sus accesos al portal donde ellos mismos ven sus viajes.",
    paraQueSirve: [
      "Tener el RUC, la dirección y los contactos correctos para facturar sin rebotes.",
      "Separar el contacto que firma del contacto que coordina el bus a las cinco de la mañana.",
      "Dejar registradas las condiciones pactadas: crédito a 30 días, moneda, tipo de comprobante.",
      "Dar acceso al portal del cliente y guardar sus documentos (contratos, órdenes de compra).",
      "Atender las solicitudes de registro que llegan desde la web.",
    ],
    conceptos: ["ruc", "factura", "boleta", "cuentas_por_cobrar", "vencimiento"],
    faqs: [
      {
        pregunta: "¿Qué cambia si marco un cliente como B2B o B2C?",
        respuesta:
          "**B2B** es una empresa con RUC; **B2C** es una persona natural con DNI. La diferencia práctica se nota en dos sitios:\n\n• Al **cotizar**: a un B2B el ERP le propone la cotización con IGV incluido; a un B2C, sin él. Se puede cambiar, pero ese es el punto de partida.\n• Al **facturar**: a una empresa le emites factura (que le sirve para su crédito fiscal); a una persona, boleta.\n\nSi el RUC está mal escrito la factura electrónica rebota en SUNAT, así que ese campo merece una revisión de más.",
      },
      {
        pregunta: "¿Para qué sirven los contactos administrativos y los operativos?",
        respuesta:
          "Porque en una empresa cliente casi nunca es la misma persona:\n\n• **Administrativos** — los de facturación y cobranza. A ellos les mandas la factura y les reclamas el pago.\n• **Operativos** — los del día a día. A ellos les avisas que el bus se retrasó o que cambia el paradero.\n\nMandarle un cambio de horario al área contable es la forma más rápida de que nadie se entere. Marca además cuál es el contacto **principal** de cada grupo.",
      },
      {
        pregunta: "¿Qué son las “Solicitudes” de la segunda pestaña?",
        respuesta:
          "Son empresas o personas que pidieron registrarse **desde fuera**, por la web. Llegan con su información pero **todavía no son clientes**: están esperando tu visto bueno.\n\nRevisa los datos (sobre todo el RUC y la razón social), corrige lo que haga falta y apruébala. Recién ahí se crea la ficha de cliente con sus contactos.\n\nEl número rojo en la pestaña te dice cuántas están esperando. Una solicitud sin atender es un cliente que quiso comprarte y se quedó en la puerta.",
      },
      {
        pregunta: "¿Qué es el “acceso al portal” que puedo crear desde la ficha?",
        respuesta:
          "Es una cuenta para que **el propio cliente** entre a ver lo suyo: sus servicios, sus horarios y sus documentos, sin llamarte a preguntar.\n\nSe crea con el nombre de la persona, su documento (**DNI de 8 dígitos**, carné de extranjería o celular) y una **contraseña, que es obligatoria** — no hay ninguna clave por defecto ni se arma sola con el DNI: si no la escribes, el ERP no crea el usuario. Si pones el correo, puede enviarle las credenciales por email.\n\nEliges además el rol —**Visor** (solo lectura) o **Admin** (gestión completa)— y qué módulos ve: *En vivo · GPS*, *Historial de servicios*, *Reportes de embarque*, *Facturación*, *Documentos* y *Cuenta y configuración*. **Facturación viene desmarcada de fábrica**: actívala solo si de verdad quieres que el cliente vea sus comprobantes.\n\nLos **documentos** que subes a la ficha del cliente (contratos, órdenes de compra, cartas) se guardan en un almacén privado: no son enlaces públicos, se abren firmados y solo desde el ERP.",
      },
    ],
    relacionadas: [
      { etiqueta: "Cotizaciones", href: "/cotizaciones" },
      { etiqueta: "Pasajeros", href: "/pasajeros" },
      { etiqueta: "Liquidaciones", href: "/liquidaciones" },
      { etiqueta: "Facturación", href: "/facturacion" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CRM · INBOX
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "crm",
    rutas: ["/crm"],
    titulo: "Inbox CRM · todas las conversaciones en un solo sitio",
    resumen:
      "Es la bandeja unificada: lo que llega por WhatsApp, Messenger, Instagram, correo o teléfono entra aquí, se responde desde aquí y queda guardado aquí — con la IA proponiendo respuestas que tú apruebas.",
    paraQueSirve: [
      "Que un pedido no se pierda porque entró por Instagram y nadie mira Instagram.",
      "Responder desde una sola pantalla, sin saltar entre aplicaciones.",
      "Tener el historial completo de lo hablado con cada contacto.",
      "Convertir una conversación en cotización o en reserva sin volver a teclear los datos.",
    ],
    conceptos: ["pago_reportado"],
    faqs: [
      {
        pregunta: "Apareció una tarjeta «📅 Reserva de traslado» en el chat. ¿Qué hago con ella?",
        respuesta:
          "La dejó la IA cuando el cliente aceptó una cotización de traslado. La tarjeta dice en qué estado está, el plazo para confirmar la unidad, el dinero (total, adelanto, saldo, lo cobrado) y **lo que falta**, con quién lo tiene que hacer: el cliente, el CRM, Tesorería, Programación o Facturación.\n\nLos botones son solo los que tienen sentido en ese momento: **✅ Hay unidad** crea la reserva en Programación y le escribe al cliente; **❌ No hay unidad** la cierra (y si pagó, se le devuelve todo); **Pedir otro comprobante**, **Registrar el último comprobante**, **Resolver cancelación** (se elige el % que se devuelve según la política), **Vincular cliente** y **Emitir y enviar Confirmación**. Antes de cada uno sale una pregunta que dice qué dinero o qué mensaje va a salir.\n\n**Quién pulsa qué**: «Hay unidad» y «No hay unidad» exigen además el módulo **Programación** (crean o descartan la reserva ahí). **Resolver cancelación** lo decide **Tesorería** (módulo Finanzas o Cuentas por Pagar), desde aquí o desde Tesorería → Adelantos de reservas. Si alguien está creando la misma reserva desde /cotizaciones («→ Res.») en ese momento, «Hay unidad» espera su turno y no la duplica.\n\nSi pasaron más de 24 horas desde el último mensaje del cliente, WhatsApp no deja escribirle desde el CRM: la tarjeta te da el texto y un enlace wa.me para mandarlo desde el celular (y el PDF de la Confirmación para adjuntarlo). Registrar el adelanto o una devolución es de Tesorería: esos botones solo los ve quien tiene ese módulo.",
      },
      {
        pregunta: "¿Qué canales entran aquí y por qué hay dos números de WhatsApp?",
        respuesta:
          "Entran **WhatsApp, Messenger, Instagram, Gmail** y las **llamadas** que registres a mano. Cada conversación viene con su etiqueta de canal.\n\nSon dos números porque cumplen funciones distintas: uno de **Ventas** y otro de **Avisos** (el que manda los recordatorios a los pasajeros). Los dos caen en esta misma bandeja, y si te estorba mezclarlos hay un filtro por número.\n\nOjo: este WhatsApp es el **oficial de Meta**, el de la empresa. No confundir con el número del **Radar IA**, que es un teléfono aparte dedicado a escuchar grupos.",
      },
      {
        pregunta: "¿Por qué no me entran los correos al CRM?",
        respuesta:
          "Mira la **línea de estado del Gmail**, arriba a la izquierda, debajo de los botones: dice qué cuenta está conectada, cuándo se leyó por última vez y, si algo falla, **qué falla y cómo se arregla**.\n\n**«Falta en Vercel GOOGLE_…»**: el ERP todavía no tiene las credenciales de Google. La línea nombra **exactamente** la variable que falta y, si es la de redirección, su **valor exacto** con un botón «copiar». Se sacan en Google Cloud (Credenciales → ID de cliente de OAuth, tipo «Aplicación web», con esa misma dirección en «URIs de redireccionamiento autorizados»), se pegan en Vercel → Environment Variables y después hay que hacer **Redeploy**: las variables solo entran en un despliegue nuevo.\n**«Gmail sin conectar»**: pulsa **📧 Conectar Gmail**, elige la cuenta de atención al cliente en Google y acepta.\n**«Google ya no acepta el permiso…»**: el acceso caducó o se quitó. Pulsa **📧 Reconectar**. Si se corta cada 7 días, la app de Google está en modo «Prueba» y hay que pasarla a producción en Google Cloud (el mensaje lo explica).\n**«leído hace X min»** y aun así no ves un correo: el ERP no importa los correos de tu propia empresa (un compañero que escribe al buzón no es un cliente), ni el spam.\n\nEl ERP lee el correo **solo, cada 10 minutos**; el botón **📧↻** lo lee al instante y te dice cuántos correos nuevos trajo. Si el Gmail estuvo desconectado varios días, al reconectarlo se recuperan los correos de esos días (hasta un mes atrás).",
      },
      {
        pregunta: "¿Dónde veo el número de teléfono del que me escribe?",
        respuesta:
          "Al lado del nombre, arriba del chat, con un **📞** delante. Púlsalo y el número se copia al portapapeles; la flechita verde de al lado abre ese mismo chat en WhatsApp.\n\nTambién sale en la lista de la izquierda, debajo de cada conversación, para que puedas barrer la bandeja sin abrir hilo por hilo. Y el buscador acepta números: da igual que teclees **987654321** o **+51 987 654 321**, encuentra igual.\n\nNo lo confundas con el chip gris de la derecha, que dice **Ventas** o **Avisos**: ese es **tu** número, el de la empresa por el que entró la conversación.\n\nSi un contacto aparece con el número como nombre es porque su WhatsApp no tiene nombre de perfil público. Puedes ponerle nombre desde Clientes.\n\nEn Messenger e Instagram **no hay número**: Meta no lo entrega, sólo un identificador interno. Ahí el único contacto posible es responder por el mismo canal.",
      },
      {
        pregunta: "¿La IA le contesta sola a mis clientes?",
        respuesta:
          "**Depende de cómo esté configurado el agente** en **CRM → Agente IA**, canal por canal:\n\n• **Copiloto**: la IA no escribe sola. Cuando pulsas **✨ IA** al lado del cuadro de respuesta, prepara un borrador que aparece abajo marcado como “✨ Sugerencia de la IA”, y tú decides entre enviarlo, editarlo o descartarlo.\n• **Autónomo**: la IA responde sola los mensajes de ese canal (dentro de su horario, si tiene uno). Si alguien del equipo respondió hace poco en ese chat, se aparta unas horas para que el cliente no reciba dos respuestas.\n\nEn los dos modos, arriba del chat hay un interruptor que alterna entre **“🤖 IA activa”** y **“🤖 IA pausada”**, y afecta solo a ese hilo.\n\nLas **cotizaciones de traslado** tienen su propia regla: mira la pregunta de la tarjeta **🚐**.",
      },
      {
        pregunta: "Escribí reglas en «Sobre la empresa» y la IA hace lo que dicen los Ajustes. ¿Cuál manda?",
        respuesta:
          "**En los temas que tienen un ajuste, manda el ajuste.** En **CRM → Agente IA → Ajustes** eliges cómo trata al cliente (**de usted** o **de tú**), si pide los datos que faltan **todos juntos** o **uno por mensaje**, cuándo muestra el **resumen del pedido** (y su título y su cierre), qué ofrece cuando el cliente solo saluda, cómo se presenta, si lee fotos y notas de voz, qué lugares no necesitan dirección exacta, cuándo pasa el chat a una persona, cuántas horas se aparta si contesta alguien del equipo y el **horario de atención del equipo**. Si la persona, «Sobre la empresa», los objetivos o la base de conocimiento dicen otra cosa sobre alguno de esos temas, la IA sigue el ajuste, y la pantalla te avisa de cada choque con la frase exacta para que la corrijas o cambies el ajuste. El recuadro ámbar de arriba de las pestañas los lista por tema —la frase, el ajuste que manda y cómo arreglarlo—: **Ver la frase** te lleva al texto con la frase marcada e **Ir al ajuste**, al control; las pestañas y los textos con choques llevan su número. Nunca edita tu texto ni te impide guardar: si un cambio agrega choques nuevos, al guardar te los nombra y decides. Las frases que solo repiten un ajuste salen aparte, en gris: no hace falta cambiarlas, pero si un día cambias el ajuste quedarán diciendo otra cosa. En todo lo demás (qué hace la empresa, precios, preguntas frecuentes, el tono) manda lo que escribiste.\n\nLos mensajes que escribe el **sistema** —el de derivación por defecto, el de una cotización de traslado, el «me falta…»— usan el **mismo trato** y el **mismo modo de preguntar**, así que el cliente no recibe una frase de usted y otra de tú.\n\nEl **horario de atención del equipo** no es el horario en que la IA contesta sola: sirve para que, fuera de él, el mensaje de derivación diga cuándo responde un ejecutivo. Y hay cosas que **ningún texto** puede pedirle a la IA porque el sistema no las hace: escribirle al cliente sin que él escriba (recordatorios, seguimientos) o llamarlo por teléfono.",
      },
      {
        pregunta: "Me sale “Aprobar y crear” en una conversación. ¿Qué crea exactamente?",
        respuesta:
          "Cuando la IA reconoce un pedido concreto en el mensaje (“necesito una van para 12 personas el jueves a Cajamarquilla”), arma lo que la pantalla llama una **“✨ Propuesta de cotización (IA)”** o **“✨ Propuesta de reserva (IA)”**, con los datos que entendió.\n\n**Aprobar y crear** la convierte en un registro de verdad del ERP. **Rechazar** la descarta.\n\nRevisa siempre lo que propone antes de aprobar — fecha, cantidad de pasajeros y destino son justo lo que un cliente escribe de forma ambigua por WhatsApp. Lo que se crea entra al circuito normal: la cotización hay que precisarla y aprobarla, la reserva hay que programarla.",
      },
      {
        pregunta: "¿Qué es la tarjeta «🚐 Cotización de traslado para revisar»?",
        respuesta:
          "Es una cotización de traslado que **armó la IA** por WhatsApp —con el precio del tarifario de zonas, no uno inventado— y que **no salió sola**. Ya está creada en **Cotizaciones**; lo que falta es enviarla. La tarjeta dice por qué quedó en revisión: el recojo y el destino no están en una zona con envío automático, el envío automático está apagado, el agente está en copiloto, el cliente escribió algo que hace dudar (TDR, evento, descuento…), o en el recojo, el destino o su nombre escribió algo que no debe salir impreso tal cual (un enlace, un teléfono, instrucciones de pago, un importe o un texto muy largo). En ese caso el PDF imprime solo el nombre de la zona: revisa la dirección antes de enviarla. También queda aquí si la **plantilla** del traslado trae algo que conviene mirar antes: cuentas bancarias distintas de las de la plantilla **Corporativo**, una condición con un enlace o un número de 6 o más dígitos (la nota cita la línea), o condiciones que no caben en el PDF (más de 30 líneas en una lista o una línea de más de 500 caracteres).\n\nQué puedes hacer:\n\n• **📄 Ver PDF**: lo abre tal como lo recibiría el cliente, armado desde la cotización.\n• **Abrir en Cotizaciones**: la abre en otra pestaña para corregirla. Si la editas, **el PDF que se envía sale editado**.\n• **Enviar al cliente**: te pide confirmación nombrando el número de WhatsApp y la cotización, y le manda el PDF a quien escribió en esta conversación. Sale como respuesta del equipo, así que la IA deja de contestar en ese chat por unas horas.\n• **Rechazar**: no se le envía nada al cliente.\n\nSi el envío falla —por ejemplo, el cliente escribió hace más de 24 h y WhatsApp ya no deja mandarle un documento—, la tarjeta se queda con el error del último intento para que lo veas.\n\nLas de las zonas con envío automático (en AFA, por ahora, el aeropuerto) salen solas y no pasan por aquí, salvo que el envío falle. En todas, **la disponibilidad de la unidad y la reserva las confirma un ejecutivo** después.",
      },
    ],
    relacionadas: [
      { etiqueta: "Cotizaciones", href: "/cotizaciones" },
      { etiqueta: "Clientes", href: "/clientes" },
      { etiqueta: "Radar IA", href: "/radar-ia" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // RADAR IA
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "radar-ia",
    rutas: ["/radar-ia"],
    titulo: "Radar IA · los grupos de WhatsApp, leídos por ti",
    resumen:
      "Un número de WhatsApp dedicado escucha los grupos donde circula el negocio (pedidos de servicio, vouchers de combustible, avisos de la flota), una IA lee cada mensaje y lo que sirve entra al ERP; lo que hay que mirar, sale como alerta.",
    paraQueSirve: [
      "No perder un pedido de servicio que pasó a las 11 de la noche en un grupo con 200 mensajes.",
      "Registrar las recargas de combustible desde la foto del voucher, sin teclear.",
      "Detectar anomalías: galones que no caben en el tanque, un mismo voucher repetido, un precio fuera de rango.",
      "Ver de un vistazo si hay disponibilidad de unidad para una oportunidad que acaba de entrar.",
    ],
    conceptos: ["comprobante", "costo_directo"],
    faqs: [
      {
        pregunta: "¿Qué hace exactamente y de dónde saca los mensajes?",
        respuesta:
          "Hay un **teléfono con WhatsApp dedicado al Radar** que está dentro de los grupos que tú elijas (pestaña **Grupos**). Todo lo que se escribe ahí lo recoge un programa que corre **fuera del ERP**, en un servidor propio, encendido las 24 horas.\n\nCada mensaje pasa por dos filtros de IA: uno rápido que decide si sirve o es conversación, y otro que extrae los datos (también de fotos y PDF, por eso puede leer un voucher de grifo). Según lo que sea:\n\n• un **pedido de servicio** → va a *Oportunidades*, con precio referencial y si tienes unidad libre ese día,\n• una **recarga de combustible** que cumple los requisitos → se registra en Combustible con su kilometraje,\n• **cualquier otra cosa** relevante → sale como *Alerta* para que la mires.\n\nLas pestañas de arriba son: **Feed** (todo lo que entró), **Oportunidades**, **Combustible**, **Odómetro**, **Alertas**, **Grupos** y **Configuración**.",
      },
      {
        pregunta: "El chip de conexión está en rojo. ¿Qué significa y qué hago?",
        respuesta:
          "Significa que **el servidor que mantiene abierto el WhatsApp del Radar no está respondiendo, y mientras siga así no entra ni un mensaje más**. No se pierde lo ya recibido, pero deja de llegar lo nuevo.\n\nEse chip es un botón: púlsalo y se abre la ficha con el estado actual, dónde vive el servidor y los comandos exactos para revivirlo, listos para copiar.\n\nEn corto: el servidor está en un droplet de **DigitalOcean**. Entras a *DigitalOcean → Droplets → el droplet → botón “Console”* (no hace falta SSH desde tu computadora) y ahí escribes **pm2 restart radar-worker**. Con **pm2 list** ves si está vivo y con **pm2 logs radar-worker** qué le pasó.\n\nSi el Radar deja de traer cosas sin explicación, lo primero que hay que mirar es ese chip.",
      },
      {
        pregunta: "Bloquearon el número del Radar (o quiero cambiarlo). ¿Cómo conecto otro y por qué no sale el QR?",
        respuesta:
          "Se resuelve con el botón **Generar QR nuevo** (arriba a la derecha; cuando el Radar está conectado dice **Vincular otro número**). Confirmas, el servidor borra la sesión de WhatsApp que tenía guardada y en esta misma pantalla aparece un **código QR nuevo**. Lo escaneas desde el celular del número que quieras usar: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo.\n\nDespués hay que **agregar el número nuevo a los grupos** — el Radar solo ve lo que ve su número — y revisar la pestaña **Grupos**.\n\n**Si el QR no aparece**, es por una de dos razones:\n\n• **El servidor no está corriendo.** El QR lo genera él, y los códigos de WhatsApp caducan en segundos: si el chip de conexión dice que no hay señal, primero hay que encenderlo (púlsalo y ahí están los comandos). La solicitud queda anotada y se atiende sola apenas arranque.\n\n• **El servidor tiene una versión vieja del programa** (anterior a la 1.1.0). En esas versiones, cuando WhatsApp bloqueaba el número, el Radar se quedaba reintentando para siempre con la sesión muerta y nunca llegaba a mostrar un QR — y el botón tampoco lograba forzarlo. La versión sale en la ficha del chip de conexión, junto con los comandos para forzar el QR a mano.\n\nY lo importante: **si WhatsApp bloqueó el número, ese número no vuelve**. No es cuestión de esperar ni de reintentar: hay que vincular **otro chip dedicado**.",
      },
      {
        pregunta: "Cambié el número y en Grupos siguen saliendo los del número anterior. ¿Por qué?",
        respuesta:
          "Porque la lista de grupos **se acumula, no se reemplaza**. El Radar nunca borra un grupo por su cuenta: si lo hiciera, perderías el contexto que le escribiste a ELIA, las categorías que le configuraste y el rastro de los mensajes que ya capturó de ahí.\n\nLo que sí hace es **marcarlos**. Los grupos que el número conectado ya no ve salen tachados con la etiqueta *Ya no se ve*. Y si además quedaron en **Monitorear**, salen en rojo como *Activo pero sin acceso*: ese es el caso que engaña, porque el interruptor está encendido y parece que se vigilan, pero el número nuevo no es miembro y no puede llegar ni un mensaje.\n\nQué hacer:\n\n• **Si quieres recuperar ese grupo**, pide que agreguen el número nuevo al grupo de WhatsApp. Al rato vuelve a aparecer normal, y conserva su configuración.\n\n• **Si ya no te interesa**, usa el enlace **Quitar** de la fila. Solo desaparece de esta pantalla; los mensajes que ya se capturaron no se borran.\n\nArriba de la lista está el botón **Actualizar lista**, que le pide al servidor volver a preguntarle a WhatsApp en qué grupos está el número, y la fecha de la última lectura que salió bien. Si esa fecha está vieja, es que la lectura viene fallando — pulsa el botón.\n\nY ojo con lo más común de todo: si la lista no cambia después de cambiar de número, casi siempre es que **al chip nuevo todavía no lo agregaron a los grupos**.",
      },
      {
        pregunta: "Un mensaje dice «Error». ¿Qué se perdió y cómo lo recupero?",
        respuesta:
          "**Error significa que lo que traía ese mensaje NO entró al ERP.** Si era una recarga de combustible, esa recarga no está en Combustible. Al abrir el mensaje en el **Feed** sale el motivo en rojo: es lo que dice qué arreglar.\n\nArriba del Feed aparece un aviso amarillo con **cuántos mensajes fallaron** y el botón **«Reprocesar los N»**. Los vuelve a leer de a uno, del más viejo al más nuevo, **con todas las fotos de su ráfaga** (el tablero, el surtidor y la nota, aunque hayan llegado en mensajes separados). Puede tardar unos minutos y cuesta IA; no cierres la pestaña mientras corre.\n\n**No duplica nada.** Si una recarga ya está en Combustible —porque alguien la tecleó a mano, o porque la registró la **factura del correo** mientras el Radar fallaba— el Radar la reconoce por el número de comprobante, o por placa e importe con **un día de margen** (la factura sale con su fecha de emisión, que puede ser el día siguiente al voucher), y la deja **en revisión** nombrando el registro que ya existe, en vez de registrarla otra vez.\n\nQué pasó entre el 14/09 y el 06/10: una actualización empezó a guardar el **nivel del tanque** en una columna que no existe hasta correr un SQL, y el Radar no supo saltársela. Cada recarga fallaba y el mensaje se marcaba igual como «Procesado», en verde. Las dos cosas están arregladas: si falta ese SQL la recarga se guarda igual (el detalle lo dice), y un fallo ahora se ve como **Error**.",
      },
      {
        pregunta: "¿Por qué una recarga dice «Fecha corregida» o «Fecha lejos del mensaje»?",
        respuesta:
          "Porque el Radar compara la **fecha del voucher** con la del **mensaje de WhatsApp** que lo trajo. Un voucher se fotografía después de imprimirse, casi siempre el mismo día o pocos días después, así que una fecha posterior al mensaje, o de más de **una semana** antes, casi siempre es una lectura equivocada.\n\nSi el error se explica de una sola forma —el **año** mal leído (13/08/2025 en un mensaje del 13/08/2026) o el **día y el mes intercambiados** (el 03/10 leído como 10 de marzo)—, el Radar pone la fecha buena y la marca en verde como **Fecha corregida**. Si no se puede saber cuál era, la deja como la leyó y la marca **Fecha lejos del mensaje**.\n\nEn los dos casos la recarga **no se registra sola**: queda en revisión para que la confirmes contra la foto. Una carga fechada en otro año cae fuera de su mes y desordena el rendimiento de la unidad.",
      },
      {
        pregunta: "¿Es seguro? ¿Puedo usar el WhatsApp de la empresa?",
        respuesta:
          "**Usa siempre un número dedicado, nunca el WhatsApp oficial de la empresa.** El Radar se conecta a WhatsApp por una vía **no oficial** (es la única forma de leer grupos), y ese tipo de conexión puede terminar con el número bloqueado.\n\nSi eso le pasara al número de ventas, te quedas sin canal comercial. Si le pasa al número dedicado del Radar, se consigue otro y se vuelve a escanear el QR.\n\nLos dos números oficiales de Meta (Ventas y Avisos) trabajan por otro lado, en el **Inbox CRM**, y no tienen nada que ver con esto.",
      },
      {
        pregunta: "El Radar registró una recarga de combustible. ¿Me fío?",
        respuesta:
          "Fíate del dato, pero mira las **anomalías**: el Radar marca por su cuenta cuando algo no cuadra — *Galones exceden tanque*, *Posible duplicado*, *Precio fuera de rango*, *KM no cuadra con su fecha*, *Consumo excesivo*, *Recarga de madrugada*, *Monto inconsistente*.\n\nLo que el Radar SÍ arregla solo es un **dígito mal leído**. El voucher imprime cantidad, precio e importe, y los tres están atados: **cantidad × precio = importe**. Si la IA lee 6.799 galones donde el papel dice 8.799, la cuenta la delata (6.799 × 24.64 da S/ 167.53 y el voucher dice S/ 216.81) y el Radar reemplaza el número por el único que el papel admite, con la etiqueta verde *Lectura corregida* y la explicación completa al abrir la fila. **Nunca se registra sola**: queda esperando que mires la foto y confirmes, con el número bueno ya escrito en el formulario. Y si no cuadra pero ningún dígito lo explica —un descuento del grifo, o un precio leído de otra nota—, **manda el importe**: es lo que se pagó y se imprime dos veces, así que el Radar guarda el precio que lo reproduce (importe ÷ cantidad) con la etiqueta *Precio según el importe* y los dos precios a la vista. Si la diferencia es grande (más de S/ 2 o del 5 %), no toca nada y la deja en revisión como *Monto inconsistente*.\n\n**El grifo no es el «RAZ.SOC» de la nota.** Una nota de despacho trae dos empresas: arriba, en el encabezado, la estación que vendió (COESTI, Primax…); más abajo, en el campo *RAZ.SOC*, la que compró — o sea AFA, o el transportista dueño del bus. Como ese campo se llama literalmente «razón social», la IA llegaba a guardar ahí el grifo y salían recargas cuyo proveedor era *GLOBAL BUS PERÚ S.A.C.* o incluso *AFA TOURS PERÚ S.A.C.* El ERP ahora lo corta solo: una empresa que él ya conoce —la propia o una de tus tercerizadas— **no puede ser el grifo de su propio voucher**, así que borra el nombre en vez de guardarlo mal. Si el RUC del encabezado es el de un grifo que el ERP ya conoce (por sus facturas del correo o la cuenta de combustible), el grifo se nombra por ese RUC y la recarga sigue su camino; si no, te pide completarlo mirando la foto. Un grifo en blanco se nota; un grifo equivocado pasa por bueno y te ensucia el historial de precios por estación.\n\n**Una empresa, un nombre.** El grifo se guarda con la razón social de su factura SUNAT, se haya leído como se haya leído: «COESTI», «Coesti SA» o «CORATI SA COESTI» quedan como *COESTI S.A.* (la reconoce por el RUC, o por la razón social completa dentro del nombre). La marca de la estación no es la empresa: «Primax» no se convierte en COESTI, porque hay estaciones Primax de otros dueños.\n\nPara que una recarga **se registre sola** en Combustible tienen que cumplirse todas estas condiciones: que el registro automático esté activado en **Configuración**, que la **placa venga leída del voucher** (si el Radar tuvo que adivinarla, no pasa: no se le carga gasto a una unidad supuesta), que estén la cantidad y el importe, que la lectura tenga confianza suficiente, y que **no haya ninguna anomalía bloqueante**. Ojo con esto último: no todas bloquean — algunas quedan como observación y la recarga entra igual, con la marca puesta.\n\nSi algo de eso falla, la recarga **queda en revisión** con sus motivos, esperando que un humano la mire. Revisa esa cola: lo que se queda ahí no está en tus costos.\n\n**El kilometraje se compara con el odómetro de la FECHA del voucher, no con el de hoy.** Un voucher que revisas una semana después siempre tiene menos km que la unidad hoy, y eso no es un error: el Radar mira la lectura anterior y la posterior a la hora del voucher. Si ves recargas viejas marcadas *KM menor al de HOY*, la pestaña ofrece **volver a juzgarlas**.\n\n**Si dice *Posible duplicado*, no la descartes sin abrirla: fusiónala.** Si la carga entró desde la factura del correo (botón **🔗 Fusionar**), toma del voucher la fecha del despacho, el odómetro y el conductor; la plata sigue siendo la de la factura. Si la registró el propio Radar de otro reporte o una persona (botón **📎 Fusionar … (sumar sus fotos)**), esta fila queda enlazada a esa carga: sus fotos —el tablero, el surtidor— pasan a verse en Combustible y la carga toma lo que le falte, sin mover su fecha. El recuadro enseña las dos lado a lado; si no las une la misma nota de despacho, tienes que marcar que comparaste las fotos antes de fusionar. Si a la carga la registró una factura del correo, ahí mismo tienes **📄 Ver la factura** (el PDF, sin salir de la pantalla) y **✉ Abrir el correo en Gmail**.\n\n**Al abrir la fila puedes corregir TODO lo que leyó la IA antes de registrarla**, incluido el **odómetro** — que es el dato con el que más se equivoca (el error típico es un dígito de más: *23 980* leído como *239 980*). Debajo del campo sale el kilometraje vigente de esa unidad para que compares, y si el número es imposible te lo dice ahí mismo. Ese kilometraje no se queda dentro de la recarga: alimenta el odómetro del vehículo, de donde salen el vencimiento de su mantenimiento y su rendimiento km/gal, así que un dígito de más ensucia las dos cosas. Si la lectura no cuadra con el historial se guarda igual pero queda *por revisar* en Mantenimiento, y la pantalla te dice por qué. Dejarlo **vacío también es válido** (un voucher sin foto del tablero no trae odómetro): la recarga entra igual, solo que el rendimiento de ese tramo no se puede medir.\n\nEso importa por una razón de dinero: ese consumo es **costo directo** del vehículo y del servicio, y es lo que después hace que la rentabilidad por servicio sea real y no un número bonito. Un voucher duplicado que entra dos veces te hace creer que gastaste de más; uno que nunca entra te hace creer que ganaste de más.\n\nEn la pestaña **Configuración** puedes fijar un **límite diario de gasto en IA (en dólares)**. Cuando se llega al tope, los mensajes no se pierden: quedan pendientes hasta el día siguiente.",
      },
      {
        pregunta: "¿Reviso primero las recargas del Radar o las facturas del correo?",
        respuesta:
          "**Primero el Radar, después las facturas.** En **Combustible** revisa las recargas «Por revisar» hasta que no quede ninguna —la pestaña las enseña todas, no solo las más recientes, y cuando no queda ninguna lo dice en verde—; después pasa a **Combustible → 📧 Facturas**.\n\n" +
          "El voucher trae lo que la factura no tiene: la **fecha del despacho**, el **odómetro** y el **conductor**. Lo que registras aquí se enlaza solo a su línea de factura en la próxima lectura del correo; mientras siga por revisar, esa línea dice «En revisión del Radar» y la factura no se cierra. Las que llevan **📧 factura esperando** son las que ya tienen su factura en el correo: empieza por esas.\n\n" +
          "Si se hace al revés no se duplica nada —el botón **Registrar** comprueba antes si la carga ya entró desde la factura y, si es así, propone **fusionarla**—, pero se trabaja dos veces.",
      },
      {
        pregunta: "¿Cómo sé si el Radar está leyendo? ¿Y qué pasa con el combustible si deja de leer?",
        respuesta:
          "El chip de arriba dice si **WhatsApp** está conectado y si el **servidor** late. Pero el Radar también puede dejar de leer con el chip en verde: si la **API de IA se queda sin saldo** o rechaza la clave, si se llega al **límite de gasto de hoy**, si los mensajes **se quedan en la cola**, o si sacaron al número de algunos **grupos**. Para eso hay un recuadro debajo del chip que nombra la causa y dice dónde se arregla — por ejemplo: «La API de IA del Radar se quedó sin saldo: desde hoy 14:05 no se puede leer ningún mensaje. Recarga la cuenta de Anthropic y después reprocesa los que fallaron».\n\n" +
          "**Mientras el Radar no lea, el combustible de la cuenta de Primax no se pierde:** su factura llega al correo y la registra al día siguiente, pero **sin odómetro** y con la fecha deducida. Esas cargas quedan en **Combustible → 📧 Facturas → ✍ Cargas por completar**, donde alguien pone el km del voucher y confirma la fecha. La misma alerta sale arriba de esa pestaña.\n\n" +
          "**Lo que no llega por el correo** —cargas en otros grifos— hay que registrarlo a mano en Combustible mientras el Radar esté caído.",
      },
      {
        pregunta: "En la pestaña Odómetro, ¿cómo veo solo las lecturas pendientes de revisar?",
        respuesta:
          "Si hay alguna, la pestaña **ya se abre en ellas**: el botón **⚠ Pendientes de revisar** sale marcado. *Pendiente* es lo que espera a una persona: las **Por revisar** (se aceptan o se corrigen) y las **Rechazadas** (se corrigen). El número de la pestaña cuenta exactamente esas.\n\n" +
          "Debajo de cada título de columna hay un **filtro**: fechas *desde/hasta* en Fecha, placa y flota en Unidad, km *desde/hasta* en Kilometraje (puedes escribir 23,980 o 23.980), con o sin foto en Foto, y en Estado el estado y el **tipo de problema** (dígito de más, retrocede, salto improbable…). Cada opción dice entre paréntesis **cuántas lecturas hay** con los otros filtros puestos. Pulsar un título **ordena** por esa columna; pulsarlo otra vez invierte el orden.\n\n" +
          "En una lectura pendiente el **motivo se lee en la misma fila**: es lo que hay que resolver. Con varias placas pendientes, los botones **Por placa** filtran de un clic. Los filtros buscan en **todo** el historial del Radar, no solo en las lecturas más recientes; si te quedas sin filas, **Limpiar filtros** vuelve a mostrarlas todas.",
      },
      {
        pregunta: "Un conductor mandó la foto del tablero sin escribir la placa, ¿a qué unidad la asigna el Radar?",
        respuesta:
          "**El tablero no muestra la placa, así que el Radar nunca la elige por cómo se ve la foto.** Busca la unidad en este orden:\n\n" +
          "1. La placa **escrita** en el mensaje o en los mensajes de al lado (\"placa BUI 2 7 2\", \"cwz-371\").\n" +
          "2. Si no está escrita, el **número de celular** de quien mandó la foto: lo busca en la ficha de los conductores —propios y de terceros— y toma la **unidad que ese conductor tenía en servicio ese día** en Programación.\n" +
          "3. Si el número no está en ninguna ficha, el conductor no tenía servicio ese día o tenía dos unidades, la lectura **no se graba sola**: llega una alerta «unidad sin identificar» que dice cuál de esas tres cosas pasó y dónde se arregla.\n\n" +
          "Para que funcione, el **celular de cada conductor tiene que estar en su ficha**, y el servidor del Radar en la versión **1.4.0** o superior (en los grupos nuevos de WhatsApp, las versiones anteriores no guardan el número de quien escribe).",
      },
      {
        pregunta: "¿Qué significa «⚠ Placa sin confirmar» en la pestaña Odómetro?",
        respuesta:
          "Que la lectura está en una placa que **nada respalda**: no está escrita en el mensaje y no es la unidad que manejaba quien mandó la foto. Son lecturas que el Radar grabó **antes** de decidir la unidad por el celular del conductor: la IA eligió la placa por el parecido del tablero. Si quedó **Registrada**, ese km es hoy el **vigente** de una unidad que no era, y puede estar haciendo descartar como «retroceso» las lecturas buenas de los días siguientes.\n\n" +
          "El botón **⚠ Placa sin confirmar** las muestra todas, en cualquier estado. En cada una:\n" +
          "- **↪ Pasar a XXX** aparece cuando el Radar sabe de qué unidad es (el conductor tenía esa unidad en servicio ese día). Abre la corrección con la placa ya puesta: la lectura se registra en la unidad correcta con su foto, fecha y hora —y allí se valida como cualquier otra— y se anula en la equivocada.\n" +
          "- **↪ Corregir unidad** aparece cuando no se sabe: mira la foto y escribe la placa correcta, o déjala vacía para solo anularla.",
      },
    ],
    relacionadas: [
      { etiqueta: "Inbox CRM", href: "/crm" },
      { etiqueta: "Combustible", href: "/combustible" },
      { etiqueta: "Cotizaciones", href: "/cotizaciones" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // REDES SOCIALES
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "redes",
    rutas: ["/redes"],
    titulo: "Redes sociales · una publicación al día, aprobada por ti",
    resumen:
      "Cada mañana la IA deja redactado el texto del día. Tú lo revisas, lo apruebas, y sale a Facebook, Instagram, TikTok y YouTube. El estado de WhatsApp llega listo a tu celular para que lo publiques tú.",
    paraQueSirve: [
      "Sostener la presencia diaria en redes sin que alguien tenga que sentarse a escribir cada mañana.",
      "Que nada se publique sin que una persona lo haya leído antes.",
      "Ver en una sola pantalla en qué red salió, en cuál no y por qué no.",
      "Tener guardado lo publicado cada día, con quién lo aprobó.",
    ],
    faqs: [
      {
        pregunta: "¿La IA publica sola?",
        respuesta:
          "**No.** Redacta y deja la propuesta esperando. Nada sale a ninguna red hasta que alguien pulsa **«Aprobar y publicar»**, y queda escrito quién lo aprobó y cuándo.\n\nEs la misma regla del resto del ERP: el sistema propone con la evidencia delante y firma una persona. Una publicación no se puede despublicar de la memoria de quien la vio.",
      },
      {
        pregunta: "¿Por qué no se publica en los estados de WhatsApp como en las demás?",
        respuesta:
          "Porque **no existe ninguna API para publicar estados de WhatsApp**. No es que falte configurarlo: la API oficial de Meta manda mensajes a conversaciones y nunca ha tenido esa función.\n\nLo único que los publica es un programa no oficial, y eso choca con dos cosas: el número de atención al cliente está en la API oficial y conectarlo por ahí la rompería; y un estado **solo lo ven los contactos que tienen ese número guardado**, así que publicarlo desde un chip que nadie tiene agendado sería publicar para nadie.\n\nPor eso el agente te manda la pieza ya armada al celular y tú la publicas desde el número de atención al cliente, que es el que tus clientes sí tienen guardado.",
      },
      {
        pregunta: "YouTube y TikTok son video. ¿Qué pasa los días que no grabé nada?",
        respuesta:
          "Tú decides, publicación por publicación, con el selector **«Video de hoy»**:\n\n**Sin video** — salen Facebook e Instagram con la imagen, y las de video se saltan ese día. La pantalla lo dice; no se inventa un relleno.\n\n**Que el agente dirija y arme el Reel/Short** — la IA **mira tus fotos**, escribe el guion (qué se ve en cada escena, qué frase va encima, cuánto dura, cómo se mueve la cámara) y el navegador lo monta en vertical.\n\n**Video propio** — subes el que grabaste. Es lo que de verdad hace crecer un canal.",
      },
      {
        pregunta: "¿La IA genera el video?",
        respuesta:
          "**No genera imágenes ni grabaciones: dirige.** Ningún modelo de Anthropic produce video, y decirte lo contrario sería venderte algo que no hace.\n\nLo que sí hace es mirar las fotos que subiste y escribir el **guion**: qué foto se ve en cada escena, qué frase corta va encima, cuánto dura y cómo se mueve la cámara. Con eso, el navegador monta un vertical de varias escenas, con transiciones y el texto entrando línea a línea.\n\n**El texto del video NO es el texto de la publicación.** El caption se lee con el dedo quieto; lo que va sobre el video son cuatro a siete palabras que se leen mientras la imagen se mueve. Por eso la IA escribe frases nuevas para la pantalla en vez de repartir el caption.\n\nCuantas más fotos subas (**«Fotos de apoyo»**), más escenas distintas puede repartir. Con una sola, el video es un zoom sobre ella.",
      },
      {
        pregunta: "El guion dice «reparto automático del texto». ¿Qué significa?",
        respuesta:
          "Que la IA todavía no lo ha escrito, y el video se montaría repartiendo tus frases por escenas. Funciona, pero sale peor: las frases no tienen por qué corresponder con lo que se ve en cada foto.\n\nPulsa **«✨ Escribir guion»** y la IA mira las fotos antes de escribirlo. Puedes volver a pedirlo las veces que quieras con «Otro guion».\n\nEl guion se lee entero en la pantalla **antes** de montar nada: ahí es donde cuesta un clic corregirlo, y no veinte segundos de grabación.",
      },
      {
        pregunta: "Armé el video y salió con tramos congelados.",
        respuesta:
          "Pasó porque cambiaste de pestaña mientras se grababa. El navegador **deja de pintar** lo que no se está viendo, así que el video se queda clavado en un cuadro mientras la grabación sigue.\n\nNo se puede evitar: el video se monta en tu navegador porque es lo único que no exige montar un servidor de render aparte. Déjala a la vista los segundos que dura y rehazlo. Si ocurrió, el ERP te lo dice al terminar.",
      },
      {
        pregunta: "Una red dice que no va a publicar. ¿Cómo sé por qué?",
        respuesta:
          "La columna de la derecha explica cada red por separado, con el motivo **y dónde se arregla**. No es el mismo problema que falte conectar la cuenta, que el texto no quepa, o que hoy no haya video.\n\nSolo se pintan en **ámbar** los motivos que alguien tiene que atender. Que TikTok no publique porque hoy elegiste «sin video» no es un fallo: es lo que pediste, y por eso sale en gris.",
      },
      {
        pregunta: "Solo publica de transporte de personal. ¿Y el turismo, los paseos escolares y el alquiler?",
        respuesta:
          "Ya no. En **Ajustes → Líneas de negocio que publicas** marcas las que de verdad prestas —**transporte de personal**, **turismo**, **paseos escolares** y **alquiler de buses**— y el agente **rota** entre ellas, una por día, para que el canal no hable siempre del mismo negocio.\n\nNo es un tema: cada línea le habla a otra persona y le puede prometer otras cosas. Al jefe de planta que contrata el transporte de su gente y al colegio que organiza un paseo no se les dice lo mismo.\n\nEn la pestaña **Hoy** puedes tocar otra línea para redactar el post de hoy con ese enfoque. Cambiarla **reemplaza el texto**: cambia a quién le habla, así que no es un rótulo que se pueda corregir encima de lo ya escrito.\n\nMarca solo las que prestas. Publicar sobre un servicio que no das es prometerle algo a quien pregunte por él.",
      },
      {
        pregunta: "¿Qué cuida el agente en cada línea?",
        respuesta:
          "Cada línea trae escrito lo que **no** se puede decir en ella, y no es lo mismo:\n\n**Transporte de personal** — nunca el cliente, la ruta, la placa ni el conductor: son datos de un contrato.\n\n**Turismo** — AFA pone el transporte. No promete destinos, itinerarios, precios, fechas de salida, guías ni entradas: eso se pacta viaje por viaje.\n\n**Paseos escolares** — nunca el nombre de un colegio, de un alumno ni de un docente. Y cuando eliges esta línea, la pantalla te avisa en ámbar: **revisa las fotos, no pueden verse caras de menores identificables**, ni uniformes con logo ni listas de alumnos. Eso no lo puede controlar la IA, lo controla quien sube la foto. Publicar la imagen de un menor sin autorización no es un problema de marketing.\n\n**Alquiler de buses** — no da precios ni afirma disponibilidad: depende del día.",
      },
      {
        pregunta: "¿La IA se puede inventar datos sobre la empresa?",
        respuesta:
          "Tiene **prohibido** escribir cifras, años de experiencia, número de unidades, certificaciones, premios o porcentajes, y también superlativos del tipo «los mejores» o «líderes del mercado».\n\nLa razón es que un número inventado se publica en nombre de la empresa y no se puede retirar. Si no está tecleado en **Ajustes**, para la IA no existe.\n\nEn **Ajustes → Prohibido mencionar** puedes añadir lo que sea propio de tu operación: nombres de clientes, tarifas, placas, rutas concretas.",
      },
      {
        pregunta: "¿Qué pasa si no apruebo nada en todo el día?",
        respuesta:
          "No se publica nada, y eso es correcto. La propuesta se queda esperando y al día siguiente se redacta otra.\n\nNo hay ningún camino por el que una publicación salga sin aprobación: el botón **«Publicar ahora»** solo adelanta la **hora** de algo que ya firmaste.",
      },
    ],
    comoHacer: [
      {
        titulo: "Publicar lo de hoy",
        pasos: [
          "Entra a **Redes sociales → Hoy**. Si no hay propuesta, pulsa «Pedirle una a la IA».",
          "Mira la **línea de negocio** de hoy. Si quieres otra, tócala: se redacta de nuevo con ese enfoque.",
          "Lee el texto. Corrígelo si hace falta y pulsa «Guardar cambios».",
          "Sube la imagen del día. Si vas a hacer video, añade dos o tres **fotos de apoyo**: cada una puede ser una escena.",
          "Elige el modo de video: sin video, que lo dirija el agente, o sube el tuyo.",
          "Si lo dirige el agente: pulsa «✨ Escribir guion», léelo, y después «Armar video». Míralo en el reproductor antes de seguir.",
          "Mira la columna de la derecha: dice red por red qué va a pasar.",
          "Pulsa «Aprobar y publicar» y confirma.",
        ],
        advertencia:
          "Si quedan cambios sin guardar, la pantalla no deja aprobar: se publicaría el texto anterior.",
      },
      {
        titulo: "Conectar una red por primera vez",
        pasos: [
          "Ve a la pestaña **Cuentas**.",
          "Pulsa «Conectar» en la red que quieras.",
          "Sigue las indicaciones de esa tarjeta: dicen exactamente qué pegar y de dónde sacarlo.",
          "Guarda. La credencial se cifra y no vuelve a salir de la pantalla ni del servidor.",
        ],
        advertencia:
          "Lee el aviso ámbar de cada tarjeta: TikTok solo deja el video en borradores hasta que aprueben la auditoría de la app, y YouTube sube en privado mientras Google no verifique la app. Eso son trámites con la plataforma, no ajustes del ERP.",
      },
    ],
    relacionadas: [
      { etiqueta: "Inbox CRM", href: "/crm" },
      { etiqueta: "Campañas", href: "/crm/campanas" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // REPORTES
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "reportes",
    rutas: ["/reportes"],
    titulo: "Reportes · las cifras acumuladas del ERP",
    resumen:
      "Es un resumen general de toda la historia cargada en el sistema: clientes, reservas, ventas, margen, facturado, gastos y vencimientos, más el desglose de gastos por categoría y de facturas por estado.",
    paraQueSirve: [
      "Tener en una sola página los totales generales del negocio: clientes, reservas, ventas y margen.",
      "Ver en qué categorías se te va el gasto.",
      "Ver cuánto tienes facturado según el estado de las facturas, y cuántos servicios hiciste de cada tipo.",
      "Tener a mano el conteo de documentos vencidos, documentos por vencer y seguros por vencer.",
    ],
    conceptos: ["margen", "margen_real", "devengado", "percibido", "factura", "cuentas_por_cobrar"],
    faqs: [
      {
        pregunta: "¿De dónde salen estos números y de qué periodo son?",
        respuesta:
          "Salen de un **resumen general** que calcula la base de datos sobre las tablas del ERP: reservas, facturas, gastos, combustible, mantenimiento, documentos y seguros. Los cuadros de *Gastos por categoría*, *Reservas por tipo* y *Facturas por estado* se arman aquí mismo con las tablas completas.\n\nY aquí está lo importante: **no hay ningún filtro de fechas en esta pantalla**. Todo lo que ves es el **acumulado histórico**, desde el primer registro que se cargó hasta hoy. No es “el mes” ni “el año”.\n\nSi lo que necesitas es un periodo (el mes pasado, este trimestre), la pantalla correcta es **Finanzas** o **Gastos**, que sí filtran por fecha.",
      },
      {
        pregunta: "¿Por qué “Gastos” aquí no coincide con lo que veo en Gastos o en Finanzas?",
        respuesta:
          "Porque cada pantalla suma un conjunto distinto, y no todas cuentan lo mismo:\n\n• Aquí el recuadro **Gastos** va por un lado y el **Combustible** y el **Mantenimiento** por otro, cada uno en su propio recuadro. O sea: ese “Gastos” **no es tu egreso total**, le faltan los dos de al lado.\n• En **Gastos** y en **Finanzas** el egreso está consolidado: gastos generales + combustible + mantenimiento + neumáticos + caja chica.\n\nAsí que no compares esos números de cabeza entre pantallas ni te alarmes por la diferencia. **Para saber cuánto gastó la empresa de verdad en un periodo, el número bueno es el de Finanzas**, no el de esta pantalla.\n\nY si al abrir esta pantalla te salta un aviso de error y los totales salen en cero, no es que no tengas datos: es que ese resumen no está disponible en la base de datos. Eso lo arregla soporte, no se corrige desde aquí.",
      },
      {
        pregunta: "¿La “Utilidad estimada” es mi ganancia?",
        respuesta:
          "**No, y el nombre lo dice: es una estimación.** Es una resta simple: *facturado menos gastos*, del histórico completo.\n\nNo es la utilidad contable, por tres razones que conviene tener claras:\n\n1. Mezcla lo **facturado** (lo que emitiste) con lo **gastado** (lo que salió), que son dos formas distintas de contar el tiempo.\n2. No descuenta impuestos, ni depreciación del bus, ni la parte de los costos que todavía no se registró.\n3. El servicio que hiciste y no facturaste no está en el ingreso, pero su combustible sí está en el gasto.\n\n**La utilidad real la determina tu contador con los estados financieros.** Este número sirve para ver una tendencia, no para declarar ni para repartir.",
      },
      {
        pregunta: "¿Qué es la “Copia interna de AFA” del reporte de ocupación?",
        respuesta:
          "Es el correo que te llega **a ti** por cada cliente al que se le manda el reporte, y no es el mismo que recibe el cliente: **la copia interna lleva SIEMPRE las sugerencias de cambio de vehículo, aunque ese cliente las tenga apagadas**. Tiene sentido — la propuesta comercial la tiene que ver quien puede decidirla.\n\nSe enciende y se apaga con la casilla de esta pantalla, y debajo escribes a quién le llega (varios correos separados por coma).\n\nTres cosas que conviene tener claras:\n\n• **Es una sola decisión, no una por cliente.** El interruptor de *Clientes → editar* decide a qué cliente se le manda el reporte; éste decide si además te llega tu copia de todos. Por cliente sería una casilla que alguien se olvida de marcar, y te quedarías sin ver las sugerencias de ese cliente sin que nada te avise.\n\n• **Apagarla no apaga el reporte del cliente.** El cliente sigue recibiendo el suyo; lo que se pierde es que tú veas las sugerencias y los casos en que se superó lo contratado.\n\n• **Si dejas el campo de correos vacío, la copia no se apaga**: se cae a la dirección que esté configurada en el servidor y, si tampoco hay, al correo de la empresa de *Configuración → Perfil*. La pantalla te dice cuál de las dos va a usar. Si no hay ninguna en ningún lado, te avisa en ámbar: la casilla marcada y el correo sin salir es justo lo que nadie nota.\n\nSi el bloque te dice que falta correr un SQL, esto **no se guarda** todavía — pero la copia sigue saliendo exactamente como hasta ahora.",
      },
      {
        pregunta: "¿Puedo ver el reporte de un cliente sin que le llegue a él?",
        respuesta:
          "Sí: **Probar → mándame a mí el de un cliente**, justo debajo de la copia interna. Eliges el cliente, pulsas y el reporte sale **solo a los correos de la copia interna de AFA**, con las sugerencias completas.\n\nDos cosas que conviene tener claras, porque son las que lo hacen seguro:\n\n• **El cliente no recibe nada.** Ni se mira su correo. Y si la copia interna está apagada o no tiene ninguna dirección, la prueba **no sale** y te dice qué falta — nunca se le manda al cliente «porque había que mandarlo a alguien».\n\n• **No gasta su envío programado.** El del sábado (o el día que le toque) le sigue saliendo entero, al cliente y a ti. La prueba se anota aparte justamente para eso.\n\n**Puedes probar con un cliente que todavía NO tenga el reporte encendido**, y ese es el punto: sirve para ver cómo le va a quedar antes de encendérselo en *Clientes → editar*. Encenderlo es lo que empieza a mandarle correo a él; probar, no.\n\nUsa el mismo campo *Periodo que cierra el* de arriba; si lo dejas vacío, toma el periodo que cierra hoy.",
      },
      {
        pregunta: "En el reporte de ocupación, ¿la ida y el retorno cuentan como un servicio o como dos?",
        respuesta:
          "**Como UNO.** La ida y su retorno son el mismo día de la misma ruta, sobre los mismos asientos contratados, así que el reporte los cuenta juntos: 17 días de contrato salen como **1 ruta con 17 servicios**, no como dos rutas de 17.\n\n• **La ocupación del día es el tramo MÁS LLENO, nunca la suma.** Si por la mañana viajaron 34 y por la tarde 20, el día son 34 de los 50 contratados — no 54. Son las mismas personas yendo y volviendo.\n\n• **Esto evita la propuesta más peligrosa del reporte.** Con los tramos separados, el retorno (que casi siempre trae menos gente) proponía por su cuenta *«cabe en una unidad menor»* sobre un bus que por la mañana va lleno.\n\n• **Dos horarios distintos SÍ son dos rutas.** La entrada de las 06:35 y la de las 05:10 se miden por separado, cada una con su retorno: son contratos distintos y cada uno tiene su propio pico.\n\n**Lo que empareja los dos tramos es el enlace ida↔retorno del servicio, no el parecido del nombre.** Si una ruta te sale partida en dos filas —una con la entrada y otra con la salida— lo que falta es ese enlace: se repara en *Liquidaciones → «Enlazar tramo(s) ida↔retorno»*. En el Excel adjunto, la hoja *Detalle por tramo* sigue mostrando la ida y el retorno por separado con su hora y su placa.",
      },
    ],
    relacionadas: [
      { etiqueta: "Finanzas · por periodo", href: "/finanzas" },
      { etiqueta: "Gastos · rentabilidad por servicio", href: "/gastos" },
      { etiqueta: "Dashboard", href: "/dashboard" },
      { etiqueta: "Contabilidad", href: "/contabilidad" },
    ],
  },
];
