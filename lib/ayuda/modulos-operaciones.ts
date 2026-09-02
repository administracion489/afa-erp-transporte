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
    ],
    conceptos: ["estado_admin", "estado_proveedor", "tercerizado", "margen", "liquidacion_cliente", "servicio_adicional"],
    faqs: [
      {
        pregunta: "¿Qué significa cada estado y cómo avanza un servicio?",
        respuesta:
          "El servicio recorre siempre el mismo camino, y la barra “Flujo de estados” de arriba te dice cuántos hay en cada paso:\n\n• **Pendiente** — el servicio existe pero no tiene unidad ni conductor.\n• **Programada** — ya le asignaste recurso.\n• **Confirmada** — el cliente confirmó que va.\n• **En curso** — el bus está operando.\n• **Finalizada** — el servicio se realizó.\n• **Cancelada** — no se hizo.\n\n**“En curso” no se pone a mano: lo activa el conductor cuando hace su check-in por GPS desde la app.** Esa es la razón de ser del estado: significa “hay un bus rodando y lo puedo ver en el mapa”. Si lo marcaras tú, dejaría de significar eso y el mapa y el seguimiento empezarían a mentir.\n\nPara cerrar un servicio que el conductor olvidó finalizar sí hay salida: el ERP abre **“Finalizar servicio manualmente”** y te obliga a escribir el motivo. Ese motivo se guarda en las observaciones del servicio, marcado como cierre manual, para que después se sepa que esa hora no la puso el conductor.",
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
          "Por tres cosas concretas:\n\n1. **En la liquidación sale en su propio renglón**, con el rótulo ADICIONAL y sumado en *Adicionales autorizados*. Si va sin marcar, se funde con las líneas del contrato: el cliente lee “23 servicios” donde hay 22 contratados y uno pedido aparte, y el subtotal de adicionales sale en cero.\n2. **Queda escrito el porqué.** Un adicional nace con su precio, así que no dispara el enlace de conformidad del cliente (ese salta cuando a un servicio ya creado se le SUBE el precio). El motivo que escribes al crearlo es el único registro de por qué esa salida costó distinto.\n3. **No ensucia la referencia de precios.** El ERP propone “la última vez que cobraste esta ruta: S/ …”. Un adicional de S/ 480 por una unidad mayor no se propone nunca como tarifa del contrato.\n\nEn la lista los reconoces por el chip naranja **ADICIONAL**, y arriba tienes el filtro *Todo origen / Contrato / Adicionales*.",
      },
      {
        pregunta: "Quiero marcar como adicional un solo tramo, pero el sistema arrastra el hermano. ¿Cómo lo evito?",
        respuesta:
          "No se evita, y es a propósito: **lo que se cobra es el día**, no el tramo. La ida y la salida de un mismo servicio llevan una sola tarifa, así que la liquidación **contagia** el origen al par completo. Si marcaras solo el retorno, el día entero se cobraría igual como adicional — pero la pantalla mostraría la ida como *Contrato*. Ganarías una fila que miente, no una corrección fina.\n\nLo que casi siempre pasa cuando aparece esta duda es otra cosa: **la etiqueta está en el servicio equivocado**. Un día sale la ruta contratada y además un adicional, hay una contingencia (una avería, un chofer que no llega) y las unidades se intercambian el trabajo. Entonces la corrección no es marcar uno: es **canjearlos**.\n\nEn el mismo modal tienes **⇄ Fue un intercambio con otro servicio**. Eliges la contraparte, y los dos cambian de lado a la vez: este pasa a adicional y el otro vuelve a contrato. El ERP te muestra antes cuánto entra y cuánto sale de *Adicionales autorizados* — si las dos tarifas son iguales, el neto es **cero** y solo se corrige el nombre de las cosas.",
      },
      {
        pregunta: "En el canje me piden motivo y nota obligatorios. ¿Por qué, si no estoy cambiando ningún precio?",
        respuesta:
          "Porque es el **único sitio donde queda escrito**. Cambiar el origen no dispara el acta de venta ni el enlace de conformidad del cliente (esos saltan cuando se toca costo, precio, proveedor o vehículo), así que no hay ningún otro registro del movimiento. Y el lado que vuelve a *contrato* **borra** su motivo y su nota, porque describían un adicional que ya no existe.\n\nQueda entonces una sola nota, en el servicio que pasa a adicional, y ahí el ERP escribe además el **código de su contraparte**. Eso es lo que permite reconstruir el intercambio tres meses después, cuando alguien pregunte por qué esa salida figura aparte.\n\nEscribe lo que pasó de verdad: *“La unidad del adicional cubrió el retorno del contrato por avería”*. Un “corrección” a secas no le sirve a nadie en octubre.",
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
          "Para asignar recurso a todo el contrato de una vez: abre UNO de esos servicios y asígnale unidad y conductor. Al guardar, el ERP te pregunta “¿Aplicar a más servicios del contrato?” y te deja aplicar lo mismo al resto, con un rango de fechas si solo quieres una parte.",
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
    ],
    conceptos: ["estado_admin", "conformidad", "liquidacion_cliente", "tercerizado"],
    faqs: [
      {
        pregunta: "El panel de Puntualidad, ¿qué me está diciendo exactamente?",
        respuesta:
          "Está separando cosas que antes se mezclaban en un solo número rojo. Los cuatro que más vas a ver:\n\n• **Retraso confirmado** — hay evidencia de que salió tarde. Esto sí es un problema.\n• **En el punto, sin iniciar** — el GPS ubica el bus **en el paradero**. No va tarde: falta que el conductor pulse Iniciar en su app. Se arregla con una llamada de 10 segundos.\n• **Sin rastreo** — no llega señal de ese teléfono. **El ERP nunca afirma un retraso por falta de GPS**: no saber no es lo mismo que ir tarde, y decir lo contrario te haría regañar a un conductor que iba puntual.\n• **Riesgo de retraso** — una previsión con el tráfico de ahora. Todavía se puede reaccionar.\n\nHay más niveles y solo aparecen si ese día se dieron: *No se realizó*, *Retraso en ruta*, *Inició tarde* y *En hora*.\n\nCada nivel es un botón: púlsalo y la lista de abajo se filtra. El panel completo **solo sale cuando la fecha elegida es hoy** — mirando un día pasado no tendría sentido hablar de riesgo ni de tráfico.",
      },
      {
        pregunta: "¿De dónde sale la hora real de salida? Nadie la escribe.",
        respuesta:
          "Exacto, y por eso el ERP **la deduce de lo que el conductor sí dejó**: la hora en que marcó la primera parada, la hora del primer abordaje con QR, el aviso de salida a los pasajeros o el primer punto GPS del viaje.\n\nEn la columna **Salió**, la hora sale en **verde** cuando es un dato firme y en **gris y cursiva** cuando es una estimación. Pasa el cursor por encima y te dice de dónde salió: *“marcado por el conductor 05:12”*, *“abordaje QR 05:14”*, *“estimado por GPS ~05:16”*. **Ese “~” no es adorno: marca que la hora está inferida y que no debería facturarse como si fuera un dato duro** — el reloj de un teléfono puede estar desfasado.\n\nEl contador **Sin hora de salida** cuenta los servicios donde no hay ninguna evidencia. Suele ser un teléfono con el rastreo apagado, no un bus que no salió — revísalo en **Salud del GPS**.",
      },
      {
        pregunta: "Me sale “Riesgos de flota detectados”. ¿Qué tan grave es?",
        respuesta:
          "Depende de cuál de los tres sea, y la propia pantalla te lo aclara:\n\n• **Documentos vencidos** — esto sí es duro: SOAT, revisión técnica o habilitación vencidos **bloquean la salida**. Si sale y lo paran, es multa y servicio caído.\n• **Posible solape de unidad o conductor** — el mismo bus o el mismo chofer en dos servicios que parecen pisarse. Es una **estimación**: la reserva no guarda cuánto dura el servicio, así que el ERP no puede afirmarlo. Verifícalo en cada servicio marcado.\n• **Jornada extensa del conductor** — misma advertencia: es una estimación, no una medición de horas de manejo.\n\nEn resumen: el primero actúalo, los otros dos revísalos.",
      },
      {
        pregunta: "La columna Ruta, ¿es la que ve el pasajero? ¿La puedo corregir desde aquí?",
        respuesta:
          "Sí a las dos cosas, y por eso está en esta pantalla. Ese texto es **el mismo que el pasajero lee en su app para elegir su bus**: lo cambias aquí y lo verá la próxima vez que abra la pantalla. Si lo dejas vacío, al pasajero le sale el “origen → destino” del servicio, que reconoce mucho peor que un “RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA”.\n\nPara editarlo, **haz clic sobre el nombre** en la propia fila: se abre el campo ahí mismo, guardas con **Enter** o pulsando fuera, y **Esc** cancela sin guardar. Es el mismo dato que ya podías tocar en **Configurar ruta**, dentro del Manifiesto en Programación — solo que ahora no hace falta abrir el manifiesto de cada servicio para verlo.\n\n**Respeta el formato que ya usa la operación.** No es un rótulo decorativo: **este texto se imprime tal cual en la liquidación**, en el renglón del servicio que el cliente firma, y además es la identidad con la que se agrupan los servicios del mes (misma ida + mismo retorno + misma tarifa = un solo ítem). El costeo de pactos, por su lado, busca la ruta por su nombre **exacto**. Si le cambias el nombre a la mitad del mes, esa ruta sale partida en dos renglones en la valorización.",
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
      "Dos pantallas hermanas. **Monitoreo** es el mapa en vivo: dónde está cada bus ahora y qué alertas SOS hay abiertas. **Salud del rastreo** responde la otra pregunta: a qué conductores se les corta la señal durante el servicio, y por qué.",
    paraQueSirve: [
      "Ver en el mapa la flota propia y la tercerizada, con su placa y su estado de señal.",
      "Atender alertas SOS que manda el conductor desde su app.",
      "Contestar al cliente “¿dónde está mi bus?” sin llamar al conductor.",
      "Descubrir qué teléfonos están mal configurados y dejan viajes sin rastro.",
    ],
    faqs: [
      {
        pregunta: "Un bus salió pero no aparece en el mapa. ¿Está mal el GPS?",
        respuesta:
          "Casi nunca es el GPS del vehículo: el rastreo lo hace **el teléfono del conductor a través de su app**, y solo mientras el servicio está iniciado.\n\nRevisa en este orden:\n1. ¿El conductor **inició el servicio** en la app? Sin iniciar, no manda nada.\n2. ¿El servicio está **sincronizado** desde Programación? Si no, ni siquiera le aparece en su lista.\n3. ¿El teléfono tiene el permiso de ubicación en **“Permitir siempre”**? Si está en “Solo mientras uso la app”, el sistema operativo corta el rastreo apenas el conductor bloquea la pantalla.\n\nLos colores del panel te ubican: **En línea** (señal de hace menos de 2 minutos), **Hace Nm** (entre 2 y 10), **Sin señal** (más de 10 minutos) y **Sin GPS** (nunca mandó nada).",
      },
      {
        pregunta: "Llegó una alerta SOS. ¿Qué pasa cuando la marco como atendida?",
        respuesta:
          "El SOS lo dispara el conductor desde su app y entra **en tiempo real**, sin esperar refresco: aparece el botón rojo arriba y la unidad se pinta de rojo en el mapa, con su posición al momento de la alerta.\n\nPulsar **Atendido** solo registra que alguien de la oficina se hizo cargo: quién y cuándo. **No resuelve nada por sí solo** — la llamada al conductor la tienes que hacer tú.\n\nSi el hecho fue serio (accidente, robo, unidad detenida), regístralo además en **Incidencias**, que es donde queda el expediente con su plazo de atención, su responsable y su acción correctiva.",
      },
      {
        pregunta: "En “Salud del rastreo” un conductor sale al 38 %. ¿Me está engañando?",
        respuesta:
          "Lo más probable es que **no**. La columna **Cobertura** mide cuánto del viaje quedó rastreado, y un valor así es la firma clásica de un teléfono mal configurado, no de un conductor haciendo trampa:\n\n• el permiso de ubicación en **“Solo mientras se usa la app”** en vez de “Permitir siempre”, o\n• el **ahorro de batería** del fabricante matando la app en segundo plano.\n\nLa pantalla te lo clasifica sola: **Bien** de 95 % para arriba, **Aceptable** desde 90, **Irregular** desde 70 y **Mal** por debajo. Los equipos bien configurados dan 100 %, y los que tienen el permiso mal puesto rondan justo ese 35-40 %. Por eso la solución es configurarle el equipo, no llamarle la atención.\n\n**La excepción sí es grave:** si aparece el aviso rojo de **“Ubicación simulada detectada”**, esos puntos los generó una app de GPS falso, no el teléfono. Ahí sí hay que verificar el equipo antes de sacar conclusiones.",
      },
      {
        pregunta: "¿Para qué me sirve saber los “kilómetros a ciegas”?",
        respuesta:
          "Son los kilómetros del servicio que ocurrieron **sin ningún punto GPS**: tramos que no puedes probar.\n\nImporta por dos razones muy concretas. La primera es el cliente corporativo que te pide sustento del recorrido: si un tercio del viaje no tiene traza, no tienes con qué respaldarlo. La segunda es interna: sin traza tampoco puedes contrastar el kilometraje declarado ni la hora real de salida, que es justo lo que alimenta la liquidación.\n\nPuedes medir los últimos **3, 7 o 15 días**. Empieza por los cortos: con 15 días la medición a veces se pasa del tiempo límite, y la pantalla te lo dice con esas palabras y te pide que uses menos días.",
      },
    ],
    relacionadas: [
      { etiqueta: "Seguimiento operativo", href: "/seguimiento" },
      { etiqueta: "Incidencias", href: "/incidencias" },
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
      "Emitir la cotización en PDF con la plantilla que corresponda al cliente.",
      "Llevar el control de qué se cotizó, qué se envió y qué se aprobó.",
      "Convertir una cotización aprobada en un servicio o en un contrato fijo completo.",
      "Registrar y autorizar descuentos dejando constancia de quién los aprobó.",
    ],
    conceptos: ["igv", "margen", "margen_real", "costo_directo", "amortizacion", "factura"],
    faqs: [
      {
        pregunta: "¿Cómo se llega al precio? Veo tres números distintos.",
        respuesta:
          "Son tres formas de responder la misma pregunta, y el ERP te las enseña juntas para que elijas con criterio:\n\n• **🔧 Cotizador** — el precio calculado desde tus costos reales para esa ruta y esa unidad. Es el que sabe si vas a perder plata.\n• **📋 Tarifario** — el precio oficial que ya tienes fijado para esa ruta. Es el que mantiene la coherencia: que el mismo cliente no reciba dos precios distintos según quién conteste.\n• **⭐ Sugerido** — el **mayor** de los dos anteriores. El ERP no te propone nunca el más barato.\n\nCada uno tiene su botón **Usar**, y abajo queda registrado con qué criterio se fijó el precio (“Modo: cotizador / tarifario / manual”). Ese registro es lo que después te deja explicar por qué un servicio se vendió a S/ 960 y otro parecido a S/ 1,120.",
      },
      {
        pregunta: "¿Qué mete el Cotizador dentro del costo?",
        respuesta:
          "Todo lo que gasta el bus por kilómetro, no solo la gasolina. El bloque **Desglose de costos** es literalmente la cuenta:\n\n• **Combustible** (con su rendimiento real, y la UREA aparte si la unidad la usa),\n• **Neumáticos**, repartidos por kilómetro según lo que duran,\n• **Mantenimiento preventivo** por kilómetro,\n• **Depreciación** — lo que el bus pierde de valor rodando,\n• **Seguros, SOAT, permisos** — ahí dentro va también la revisión técnica, todo repartido por kilómetro,\n• **Reserva (5 %)** para lo imprevisto,\n• **Conductor** por día, más **peajes y otros**.\n\nEso suma el **costo directo**. Encima se le añade el **Overhead (10 %)** —la oficina: administración, teléfono, alquiler— y, si el viaje los tiene, el **pernocte y los viáticos**. El resultado es la **base de costo completo**, y sobre ella se calculan los tres precios: **mínimo 15 %, estándar 20 %, premium 25 %** de margen.\n\nEsos parámetros (rendimiento, precio del combustible, sueldo del conductor, vida del neumático) se editan en **Configuración → Costos**. Si están desactualizados, todo lo que cotices estará mal: revísalos cada vez que suba el combustible.",
      },
      {
        pregunta: "¿Por qué a un cliente le sale con IGV y a otro no?",
        respuesta:
          "Porque el ERP lo decide según el tipo de cliente: a una **empresa (B2B)** le propone la cotización **con IGV** y a una **persona (B2C)** sin él. Puedes cambiarlo con el interruptor del formulario; si lo apagas, el PDF sale con la leyenda “No incluye IGV”.\n\nEs una decisión comercial de presentación, no un cambio tributario: el IGV se cobra igual cuando se emite la factura. Lo único que cambia es si el número grande que ve el cliente ya lo incluye o hay que sumárselo aparte.\n\nOjo con esto al comparar precios: el **Tarifario guarda los precios SIN IGV**, y las pantallas se lo suman al mostrarlos. Un precio de tarifario de S/ 949.15 se te muestra como S/ 1,120.",
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
    ],
    conceptos: ["igv", "margen"],
    faqs: [
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
          "Es lo que significa el número de la celda:\n\n• **EVENTUAL** — precio **total del evento**. Un traslado al aeropuerto: S/ 960 y se acabó.\n• **FIJO** — precio **por día** de un contrato de transporte de personal. Ese mismo número, multiplicado por **26 días**, es lo que le facturarás al mes (el ERP te lo muestra a un costado).\n\nSon dos tarifas distintas para la misma ruta y no se comparan entre sí. Un cliente fijo paga menos por día porque te da volumen y previsibilidad; un eventual paga más porque es una sola vez.\n\nDentro de cada modo puedes además separar por **equipamiento**: Full Equipo o Básico.",
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
    faqs: [
      {
        pregunta: "¿Qué canales entran aquí y por qué hay dos números de WhatsApp?",
        respuesta:
          "Entran **WhatsApp, Messenger, Instagram, Gmail** y las **llamadas** que registres a mano. Cada conversación viene con su etiqueta de canal.\n\nSon dos números porque cumplen funciones distintas: uno de **Ventas** y otro de **Avisos** (el que manda los recordatorios a los pasajeros). Los dos caen en esta misma bandeja, y si te estorba mezclarlos hay un filtro por número.\n\nOjo: este WhatsApp es el **oficial de Meta**, el de la empresa. No confundir con el número del **Radar IA**, que es un teléfono aparte dedicado a escuchar grupos.",
      },
      {
        pregunta: "¿Dónde veo el número de teléfono del que me escribe?",
        respuesta:
          "Al lado del nombre, arriba del chat, con un **📞** delante. Púlsalo y el número se copia al portapapeles; la flechita verde de al lado abre ese mismo chat en WhatsApp.\n\nTambién sale en la lista de la izquierda, debajo de cada conversación, para que puedas barrer la bandeja sin abrir hilo por hilo. Y el buscador acepta números: da igual que teclees **987654321** o **+51 987 654 321**, encuentra igual.\n\nNo lo confundas con el chip gris de la derecha, que dice **Ventas** o **Avisos**: ese es **tu** número, el de la empresa por el que entró la conversación.\n\nSi un contacto aparece con el número como nombre es porque su WhatsApp no tiene nombre de perfil público. Puedes ponerle nombre desde Clientes.\n\nEn Messenger e Instagram **no hay número**: Meta no lo entrega, sólo un identificador interno. Ahí el único contacto posible es responder por el mismo canal.",
      },
      {
        pregunta: "¿La IA le contesta sola a mis clientes?",
        respuesta:
          "**No sin ti.** Lo que hace es **proponer**: cuando llega un mensaje, prepara un borrador que aparece abajo marcado como “✨ Sugerencia de la IA”, y tú decides entre enviarlo, editarlo o descartarlo.\n\nNada sale hasta que alguien pulsa enviar. Si en una conversación delicada prefieres que ni siquiera sugiera, arriba del chat hay un interruptor que alterna entre **“🤖 IA activa”** y **“🤖 IA pausada”**, y afecta solo a ese hilo.\n\nTambién puedes pedirle ayuda tú, con el botón **✨ IA** al lado del cuadro de respuesta.",
      },
      {
        pregunta: "Me sale “Aprobar y crear” en una conversación. ¿Qué crea exactamente?",
        respuesta:
          "Cuando la IA reconoce un pedido concreto en el mensaje (“necesito una van para 12 personas el jueves a Cajamarquilla”), arma lo que la pantalla llama una **“✨ Propuesta de cotización (IA)”** o **“✨ Propuesta de reserva (IA)”**, con los datos que entendió.\n\n**Aprobar y crear** la convierte en un registro de verdad del ERP. **Rechazar** la descarta.\n\nRevisa siempre lo que propone antes de aprobar — fecha, cantidad de pasajeros y destino son justo lo que un cliente escribe de forma ambigua por WhatsApp. Lo que se crea entra al circuito normal: la cotización hay que precisarla y aprobarla, la reserva hay que programarla.",
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
        pregunta: "¿Es seguro? ¿Puedo usar el WhatsApp de la empresa?",
        respuesta:
          "**Usa siempre un número dedicado, nunca el WhatsApp oficial de la empresa.** El Radar se conecta a WhatsApp por una vía **no oficial** (es la única forma de leer grupos), y ese tipo de conexión puede terminar con el número bloqueado.\n\nSi eso le pasara al número de ventas, te quedas sin canal comercial. Si le pasa al número dedicado del Radar, se consigue otro y se vuelve a escanear el QR.\n\nLos dos números oficiales de Meta (Ventas y Avisos) trabajan por otro lado, en el **Inbox CRM**, y no tienen nada que ver con esto.",
      },
      {
        pregunta: "El Radar registró una recarga de combustible. ¿Me fío?",
        respuesta:
          "Fíate del dato, pero mira las **anomalías**: el Radar marca por su cuenta cuando algo no cuadra — *Galones exceden tanque*, *Posible duplicado*, *Precio fuera de rango*, *KM menor al actual*, *Consumo excesivo*, *Recarga de madrugada*, *Monto inconsistente*.\n\nPara que una recarga **se registre sola** en Combustible tienen que cumplirse todas estas condiciones: que el registro automático esté activado en **Configuración**, que la **placa venga leída del voucher** (si el Radar tuvo que adivinarla, no pasa: no se le carga gasto a una unidad supuesta), que estén la cantidad y el importe, que la lectura tenga confianza suficiente, y que **no haya ninguna anomalía bloqueante**. Ojo con esto último: no todas bloquean — algunas quedan como observación y la recarga entra igual, con la marca puesta.\n\nSi algo de eso falla, la recarga **queda en revisión** con sus motivos, esperando que un humano la mire. Revisa esa cola: lo que se queda ahí no está en tus costos.\n\nEso importa por una razón de dinero: ese consumo es **costo directo** del vehículo y del servicio, y es lo que después hace que la rentabilidad por servicio sea real y no un número bonito. Un voucher duplicado que entra dos veces te hace creer que gastaste de más; uno que nunca entra te hace creer que ganaste de más.\n\nEn la pestaña **Configuración** puedes fijar un **límite diario de gasto en IA (en dólares)**. Cuando se llega al tope, los mensajes no se pierden: quedan pendientes hasta el día siguiente.",
      },
    ],
    relacionadas: [
      { etiqueta: "Inbox CRM", href: "/crm" },
      { etiqueta: "Combustible", href: "/combustible" },
      { etiqueta: "Cotizaciones", href: "/cotizaciones" },
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
    ],
    relacionadas: [
      { etiqueta: "Finanzas · por periodo", href: "/finanzas" },
      { etiqueta: "Gastos · rentabilidad por servicio", href: "/gastos" },
      { etiqueta: "Dashboard", href: "/dashboard" },
      { etiqueta: "Contabilidad", href: "/contabilidad" },
    ],
  },
];
