// ──────────────────────────────────────────────────────────────────────────────
// lib/ayuda/modulos-flota.ts — Fichas de ayuda de FLOTA, PERSONAL, DOCUMENTOS y
// CONFIGURACIÓN.
//
// Mismo criterio que el resto del sistema de ayuda: esto NO es documentación
// técnica. Está escrito para el dueño del negocio, que no es contador ni jefe de
// taller, y responde la pregunta que la persona hace de verdad ("¿por qué el
// neumático no se puede cargar a un servicio?", "¿qué hace un gerente que no
// hace un operador?"), con números y placas de la operación real de AFA.
//
// Los términos se referencian por clave contra lib/ayuda/glosario.ts. Cuando algo
// depende de un criterio contable (prorrateo, vida útil, tasas), se dice que lo
// confirme su contador en vez de inventar una certeza.
// ──────────────────────────────────────────────────────────────────────────────

import type { AyudaModulo } from "@/lib/ayuda/tipos";

export const MODULOS_FLOTA: AyudaModulo[] = [
  // ══════════════════════════════════════════════════════════════════════════
  // VEHÍCULOS · FLOTA Y DOCUMENTOS DEL VEHÍCULO
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "vehiculos",
    rutas: ["/vehiculos", "/documentos-vehiculares"],
    titulo: "Flota · las unidades y sus papeles",
    resumen:
      "Es el padrón de tus vehículos: qué unidad es, cuánto lleva recorrido, cómo está equipada y si tiene los papeles en regla para salir a trabajar. Documentos Vehiculares es la misma información mirada por el lado del vencimiento: qué SOAT, CITV o permiso se te vence y cuándo.",
    paraQueSirve: [
      "Tener una sola ficha por placa: marca, año, capacidad, kilometraje y fotos.",
      "Saber de un vistazo qué unidades pueden salir hoy y cuáles están en riesgo de papeleta.",
      "Que la descripción y las fotos de la unidad salgan automáticamente en el PDF de cotización.",
      "Ver en un calendario qué vence en los próximos 60 días, para renovar antes y no después.",
      "Enganchar cada unidad con su ficha de costos, para que las cotizaciones sirvan de referencia.",
    ],
    conceptos: ["vencimiento", "centro_costo", "amortizacion"],
    faqs: [
      {
        pregunta: "¿Qué significa que una unidad salga como “Apto” o “No apto”? ¿Quién lo decide?",
        respuesta:
          "No lo decides tú: **lo calcula el sistema mirando los documentos obligatorios de esa placa**.\n\nSi alguno de los papeles obligatorios que tienes cargados está vencido, la unidad pasa a **No apto** y aparece con el punto rojo. Si ninguno está vencido, queda **Apto**.\n\nDos cosas que conviene tener claras:\n\n• El ERP marca **siete** documentos como obligatorios: SOAT, CAT, Revisión Técnica (CITV), Tarjeta de Propiedad, Habilitación SUTRAN, Permiso Operación MTC y Tarjeta de Circulación. Para decidir Apto/No apto se miran **seis**: el CAT queda fuera a propósito, porque es la alternativa al SOAT en provincias y no todas las unidades lo llevan. Los siete sí cuentan para la barra de Completitud, y por eso esa barra llega a **7/7**.\n\n• **El semáforo solo ve lo que está cargado.** Un documento que nunca registraste no cuenta como vencido: cuenta como inexistente, y la unidad puede salir “Apto” con el papel faltando de verdad. Por eso la pantalla Documentos Vehiculares tiene la barrita de **Completitud** (por ejemplo 5/7): esa es la que te dice qué falta.\n\nOjo también con la columna **Disponibilidad** (Disponible / Ocupado / En mantenimiento / Inactivo): esa sí la pones tú a mano y responde otra pregunta — no si la unidad *puede* salir, sino si *está libre*.",
      },
      {
        pregunta: "¿Para qué sirve el semáforo de vencimientos y qué pasa de verdad si se me vence un SOAT o una CITV?",
        respuesta:
          "El semáforo tiene tres colores y una sola intención: que renueves antes, no después.\n\n• **Vigente** (verde): faltan más de 30 días.\n• **Por vencer** (amarillo): quedan 30 días o menos. Es tu ventana para trámite.\n• **Vencido** (rojo): ya se pasó la fecha.\n\nQué pasa si se vence, en concreto:\n\n• **SOAT vencido** — circular sin SOAT vigente es infracción grave. Se sanciona con multa y **retención o internamiento de la unidad**, y si hay un accidente el seguro no responde: los daños a terceros los pagas tú, de tu bolsillo.\n• **Revisión Técnica (CITV) vencida** — multa e inmovilización. En un servicio de transporte de personal, además, es lo primero que te pide el cliente en una fiscalización.\n• **Habilitación SUTRAN o Permiso MTC vencidos** — no es una papeleta de tránsito, es habilitación: sin eso la unidad no está autorizada a prestar el servicio, y el problema pasa de ser del chofer a ser de la empresa.\n\nEl costo real de un vencimiento casi nunca es la multa: es el servicio que no puedes cubrir esa mañana y el cliente que se entera.\n\n**Los montos y las consecuencias exactas dependen del reglamento vigente y de qué autoridad te intervenga.** Úsalo como semáforo de gestión, y confirma el detalle sancionador con tu asesor.",
      },
      {
        pregunta: "En la lista algunas placas dicen “⚠ sin costeo”. ¿Qué me está faltando?",
        respuesta:
          "Falta enlazar esa unidad con su **Categoría de costeo**, que es el campo del formulario que dice a qué ficha de costos pertenece (por ejemplo “Bus 45 pax”).\n\nEsa ficha es la que guarda cuánto cuesta mover esa clase de unidad: rendimiento, precio de combustible, mantenimiento por kilómetro. Mientras la placa esté sin asignar, el ERP sabe que la CWQ-400 existe pero no sabe cuánto le cuesta hacer un kilómetro, así que **las cotizaciones hechas con esa unidad no entran como referencia en el Tarifario**.\n\nSe arregla en un clic: Editar la unidad, elegir la categoría en el desplegable, guardar. Las fichas de costo se administran en Configuración → Costos.",
      },
      {
        pregunta: "¿Por qué me pide fotos y una descripción de la unidad? ¿Es solo decoración?",
        respuesta:
          "No: **ese texto y esas dos fotos se imprimen en el PDF que le mandas al cliente**, en el ANEXO 1 de la cotización.\n\nCuando eliges el equipamiento (⭐ Full Equipo o 📦 Básico) el ERP te propone una descripción hecha —para Full Equipo, “Bus con capacidad para 45 pasajeros, con aire acondicionado, sistema de audio (radio y TV), asientos reclinables con reposapiés, cortinas, bodega para equipaje y GPS en tiempo real”— y la ajusta sola si cambias la capacidad de pasajeros.\n\nPuedes reescribir ese texto como quieras. **Ojo con una cosa:** una vez que lo personalizas, el botón **↺ Restaurar texto por defecto** ya no lo pisa — está hecho para no borrarte lo que escribiste. Si de verdad quieres volver al texto automático, **borra el contenido del recuadro y recién ahí pulsa el botón**.\n\nLas fotos son dos: **Foto exterior** (lateral, frontal o 3/4) y **Foto interior** (asientos, pasillo, comodidades). Puedes subir el archivo o pegar un enlace. Si pegas un enlace de Google Drive, **el archivo tiene que estar compartido como público**, o el cliente verá un recuadro vacío en su PDF.",
      },
    ],
    comoHacer: [
      {
        titulo: "Dar de alta una unidad nueva con sus papeles",
        pasos: [
          "En Flota pulsa “+ Vehículo” y llena la placa (obligatoria), categoría, marca, modelo, año y capacidad de pasajeros.",
          "Elige la Categoría de costeo. Si la dejas vacía la unidad queda marcada como “sin costeo” y no aportará al Tarifario.",
          "Elige el equipamiento (Full Equipo o Básico): el texto de la descripción se rellena solo y es el que verá el cliente en la cotización.",
          "Sube la foto exterior y la interior.",
          "Pon el kilometraje actual y, si lo sabes, el kilometraje del próximo mantenimiento.",
          "En Capacidad de tanque, escribe la capacidad real por tipo de combustible, en la unidad que te pide cada casilla (galones para diésel, GLP y gasolina; m³ para GNV; litros para urea). Si lo dejas vacío el ERP usa un estimado por categoría, y las alertas de carga excesiva serán menos precisas. Para GLP a gas usa la capacidad del kit, no la del tanque original.",
          "Guarda. Después, con la unidad ya creada, pulsa “+ Doc” en su fila y carga uno por uno los documentos obligatorios: SOAT, CAT, CITV, Tarjeta de Propiedad, SUTRAN, Permiso Operación MTC y Tarjeta de Circulación, cada uno con su fecha de vencimiento.",
        ],
        advertencia:
          "Un documento sin fecha de vencimiento sale como “Sin fecha” y NO dispara alerta. Si no tienes la fecha a la mano, es mejor no dar por cerrado el registro: revisa la barra de Completitud en Documentos Vehiculares hasta llegar a 7/7.",
      },
    ],
    relacionadas: [
      { etiqueta: "Seguros (SOAT y pólizas)", href: "/seguros" },
      { etiqueta: "Mantenimiento", href: "/mantenimiento" },
      { etiqueta: "Neumáticos", href: "/neumaticos" },
      { etiqueta: "Costo real por unidad (Gastos)", href: "/gastos" },
      { etiqueta: "Fichas de costo", href: "/configuracion/costos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MANTENIMIENTO
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "mantenimiento",
    rutas: ["/mantenimiento"],
    titulo: "Mantenimiento · qué toca, qué se está haciendo y qué costó",
    resumen:
      "Es el taller visto desde la oficina. Cinco pestañas: qué mantenimiento toca pronto (Próximos), qué está en el taller ahora mismo (Órdenes de Trabajo), cada cuánto lo manda el fabricante (Planes Fabricante), qué se hizo y cuánto costó (Historial) y cuánto camina cada unidad (Odómetro).",
    paraQueSirve: [
      "Que un cambio de aceite se programe por kilómetro y por tiempo, lo que ocurra primero, y no por memoria.",
      "Abrir una orden de trabajo, seguirla hasta cerrarla y que su costo caiga solo en el historial.",
      "Saber cuánto llevas gastado en mantenimiento por unidad, no en global.",
      "Distinguir el mantenimiento preventivo (planificado) del correctivo (se rompió), que es el número que dice si tu flota está bien cuidada.",
      "Avisar por correo a quien corresponda cuando una unidad entra en zona de vencimiento.",
    ],
    conceptos: ["costo_directo", "centro_costo", "margen_real", "cuentas_por_pagar"],
    faqs: [
      {
        pregunta: "¿Un mantenimiento se puede cargar a un servicio concreto? ¿Para qué serviría?",
        respuesta:
          "Sí. Desde la actualización de finanzas, un registro de mantenimiento puede llevar el **servicio (reserva)** al que pertenece, igual que ya lo llevaban los gastos directos.\n\n**Para qué sirve:** es lo que permite responder la pregunta que antes no tenía respuesta — *este servicio de S/ 1,120 al final, ¿cuánto me dejó?* Cuando el costo lleva el servicio anotado, entra al cálculo del **costo real** de ese viaje y baja su margen. Cuando no lo lleva, sigue contando como costo de la unidad y del mes, pero ese viaje en particular aparece más rentable de lo que fue.\n\nLo ves en **Gastos → pestaña “Rentabilidad por servicio”**: ahí está, por cada servicio finalizado, lo que se le cobró al cliente, lo que costó de verdad y la diferencia.\n\n**Sé realista con esto:** la mayoría de los mantenimientos NO son de un servicio. Un cambio de aceite cada 10,000 km es de la unidad, no del viaje del martes. Anota el servicio solo cuando de verdad lo sea — una reparación en ruta, un lavado exigido por ese cliente. Forzar la asignación ensucia el número en vez de mejorarlo.\n\nHoy el formulario de **Nuevo registro** de esta pantalla todavía no muestra ese campo. Si necesitas que un gasto de taller pese sobre un servicio concreto, regístralo en **Gastos** eligiendo su “Reserva / Servicio”.",
      },
      {
        pregunta: "¿Qué diferencia hay entre las pestañas Próximos, Órdenes de Trabajo e Historial?",
        respuesta:
          "Son tres momentos distintos de la misma cosa:\n\n• **Próximos** = lo que *va a* pasar. Cruza el kilometraje de cada unidad contra el plan del fabricante y te dice qué está vencido y qué está por vencer. Aquí no hay dinero, solo alertas. El KPI “Sin plan” cuenta las unidades que no tienen ningún plan asignado: esas nunca te van a avisar de nada.\n\n• **Órdenes de Trabajo (OT)** = lo que *está* pasando. Una OT es el papel de taller: unidad, kilómetro de entrada, mecánico o taller, fecha programada y costo. Va **Abierta → En proceso → Cerrada**, y puede Cancelarse.\n\n• **Historial** = lo que *ya* pasó y cuánto costó. Cuando cierras una OT, el ERP te pide el kilómetro real de salida y **crea sola la fila del historial** con ese costo, marcada como finalizada. No tienes que escribirla dos veces.\n\nRegla simple: si vas a mandar la unidad al taller, abre una OT. Si estás anotando algo que ya se hizo y ya se pagó, va directo al Historial.",
      },
      {
        pregunta: "¿Qué es preventivo y qué es correctivo, y por qué el ERP los separa?",
        respuesta:
          "• **Preventivo** 🔧 es lo que haces *antes* de que se rompa, porque toca: aceite, filtros, frenos, la revisión de los 20,000 km.\n• **Correctivo** 🔨 es lo que haces *porque ya se rompió*: la caja que se quedó, el alternador en plena ruta.\n\nEl ERP los separa porque **la proporción entre los dos es el mejor indicador de salud de tu flota**, y no cuesta nada mirarlo. Si tus correctivos crecen mes a mes, tu preventivo no se está cumpliendo — y un correctivo no solo cuesta más caro en repuestos: te deja una unidad parada un día que la tenías vendida.\n\nEn los KPIs de la pestaña Historial tienes el conteo de **Preventivos** y **Correctivos**, el **Costo preventivo** y el **Costo correctivo** por separado, y el **Costo total** acumulado del filtro que tengas puesto.\n\n**Un detalle que conviene saber para no leer mal el número:** cuando cierras una Orden de Trabajo, la fila que se crea sola en el Historial entra siempre como **Preventivo**. Si esa OT era en realidad una reparación de emergencia, entra a Historial y cámbiale el tipo a Correctivo con el botón de editar. Si no lo haces, tus correctivos se ven más bajos de lo que son, que es justo el error que este indicador debería evitarte.",
      },
      {
        pregunta: "El taller me dio factura. ¿La registro aquí o en Cuentas por pagar?",
        respuesta:
          "**En los dos sitios, y no es duplicar.** Son dos preguntas distintas:\n\n• Aquí registras **qué se le hizo a la unidad y cuánto costó**. Es información de flota: alimenta el costo por vehículo, el historial de esa placa y el margen del servicio si lo atas a uno.\n\n• En **Tesorería → Cuentas por pagar** registras **el comprobante**: serie, número, RUC del taller, IGV, detracción si corresponde y saldo pendiente. Es información fiscal y de deuda: es lo que le debes a ese proveedor y lo que tu contador necesita para el Registro de Compras.\n\nEl ERP está hecho para no sumar el mismo sol dos veces: el plano de gestión (cuánto me cuesta operar) y el plano fiscal (qué comprobantes tengo) se cuentan por separado a propósito. Lo que **sí** debes evitar es registrar el mismo trabajo dos veces *dentro de esta misma pantalla* — por ejemplo cerrando la OT y además creando la fila a mano en Historial. Eso sí duplica.",
      },
    ],
    comoHacer: [
      {
        titulo: "Abrir una orden de trabajo y cerrarla con su costo",
        pasos: [
          "Entra a Mantenimiento → pestaña “Órdenes de Trabajo” y pulsa “+ Nueva OT”.",
          "Elige el vehículo, pon el “KM al abrir OT” (el del tablero al entrar) y la fecha en “Programado para (ingreso al taller)”.",
          "Si ya tienes armada una plantilla de checklist —se crean con el botón “📋 Nueva plantilla”, en esta misma pestaña— elígela en “Plantilla (genera checklist automático)”: los puntos a revisar se cargan solos en la OT. Es otra cosa que el plan del fabricante: ese vive en la pestaña “Planes Fabricante” y sirve para avisarte de cuándo toca, no para armar el checklist.",
          "Elige el taller. Hay dos campos y no es lo mismo: si ya lo tienes dado de alta, úsalo desde “Taller (directorio de Proveedores)” —así el trabajo queda atado al proveedor correcto—; “Taller ocasional” es el texto libre, para el mecánico de una sola vez.",
          "Guarda. La OT nace en estado “Abierta”.",
          "Cuando la unidad entra al taller, cambia el estado a “En proceso” desde el desplegable de su fila.",
          "Cuando salga, pon el costo total real y cambia el estado a “Cerrada”. El ERP te va a pedir el kilometraje real de cierre (te propone el que tiene la unidad, corrígelo con el del tablero).",
          "Al confirmar, se crea sola la fila en Historial con ese costo, esa unidad y ese kilometraje. Ese kilómetro es además el que vuelve a anclar el “próximo mantenimiento”, para que Próximos no siga avisando de lo que ya hiciste.",
        ],
        advertencia:
          "El costo que pongas aquí es el de gestión (lo que costó el trabajo). Si el taller emitió factura, regístrala además en Tesorería → Cuentas por pagar: eso es lo que controla la deuda, el IGV y la detracción.",
      },
    ],
    relacionadas: [
      { etiqueta: "Costo real y rentabilidad por servicio", href: "/gastos" },
      { etiqueta: "Flota", href: "/vehiculos" },
      { etiqueta: "Facturas de talleres (CxP)", href: "/tesoreria" },
      { etiqueta: "Proveedores y talleres", href: "/proveedores" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // COMBUSTIBLE · AUDITORÍA DE JORNADA
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "combustible",
    rutas: ["/combustible", "/auditoria-jornada"],
    titulo: "Combustible · cuánto se carga, cuánto rinde y a dónde se fue",
    resumen:
      "Aquí se registra cada carga de diésel, biodiésel, gasolina, GLP, GNV o urea, y el ERP calcula solo cuánto rinde cada unidad y te avisa cuando un consumo se sale de lo normal. Auditoría km es la pantalla hermana: compara los kilómetros del odómetro con los kilómetros que el GPS puede demostrar.",
    paraQueSirve: [
      "Saber cuánto gastas en combustible por mes, por unidad, por conductor y por grifo.",
      "Detectar solo dos cosas raras: una carga que no cabe en el tanque y un rendimiento que se desploma.",
      "Comparar grifos: la pestaña “Por grifo” te dice el precio promedio que te está cobrando cada uno.",
      "Ver si los kilómetros de la jornada cuadran con los kilómetros de los servicios.",
      "Alimentar el costo real de la operación y, cuando corresponde, el de un servicio concreto.",
    ],
    conceptos: ["costo_directo", "centro_costo", "margen_real", "prorrateo"],
    faqs: [
      {
        pregunta: "¿Una carga de combustible se puede cargar a un servicio concreto?",
        respuesta:
          "Sí. Desde la actualización de finanzas, un registro de combustible puede llevar anotado el **servicio (reserva)** al que corresponde.\n\n**Por qué importa:** es lo que hace que el costo real de un viaje sea real. Si un servicio a provincia se cobró en S/ 1,120 y consumió S/ 380 de diésel, ese servicio dejó menos de lo que parece. Cuando la carga lleva el servicio anotado, ese consumo entra al **costo real** de ese viaje y se ve en **Gastos → Rentabilidad por servicio**, junto a lo que se le cobró al cliente. Cuando no lo lleva, el gasto sigue contando —como costo de la unidad y del mes— pero el viaje se ve más rentable de lo que fue.\n\n**Cuándo tiene sentido anotarlo:** cuando llenas tanque para un viaje largo identificable a provincia. **Cuándo no:** la carga de rutina de un bus que hace cuatro rutas de personal al día. Ese diésel es de la unidad, no de un servicio, y repartirlo entre los cuatro es prorrateo — una decisión de criterio, no un dato (mira la nota del término “Prorrateo” aquí abajo).\n\nHoy el formulario de **Nueva carga** todavía no muestra ese campo: toda carga registrada aquí entra como costo de la unidad. Si necesitas que un consumo puntual pese sobre un servicio, regístralo desde **Gastos** eligiendo su “Reserva / Servicio”.",
      },
      {
        pregunta: "¿Qué es el “rendimiento” y cuándo el ERP me marca una anomalía?",
        respuesta:
          "El **rendimiento** son los kilómetros que la unidad hizo por cada galón (o por m³ si es GNV). Se calcula solo: kilómetros entre esta carga y la anterior de esa misma unidad y ese mismo combustible, divididos entre lo que cargaste.\n\nEl ERP levanta la bandera 🚨 en dos casos, y solo en dos:\n\n• **Carga excesiva** — cargaste más de lo que cabe en el tanque, con un 10 % de tolerancia. Si la CWQ-400 tiene tanque de 100 galones y aparece una carga de 118, algo no cuadra: o el tanque está mal configurado en la ficha del vehículo, o el galonaje del ticket está mal, o se cargó en dos unidades con un solo comprobante.\n\n• **Rendimiento anormal** — la unidad rindió 30 % o más por debajo de su propio promedio histórico. Ojo: se compara contra ella misma, no contra otras. Un bus viejo con 8 km/gal no salta; ese mismo bus rindiendo 5 km/gal, sí.\n\n**Una anomalía no es una acusación.** Las causas honestas son la mayoría: tráfico, ruta con más pendiente, no se llenó el tanque completo, o el kilometraje se anotó mal. Es una señal para preguntar, no para sancionar.\n\nPara que el aviso de tanque funcione bien, carga la **Capacidad de tanque** real en la ficha de cada vehículo. Sin eso el ERP usa un estimado por categoría.",
      },
      {
        pregunta: "En Auditoría km, ¿qué me está diciendo el “km no justificado”?",
        respuesta:
          "Es una resta, nada más: **kilómetros de la jornada menos kilómetros de los servicios**.\n\n• **Km jornada** = odómetro de cierre menos odómetro de apertura. Todo lo que la unidad caminó ese día.\n• **Km servicio** = la distancia GPS de los servicios que se finalizaron.\n• **Km no justificado** = la diferencia.\n\nY esa diferencia **normalmente no es robo**: es ir de la cochera al punto de recojo, volver de vacío, el taller, el lavado, el grifo. En transporte de personal es una parte fija y normal del día. Lo que te dice esta pantalla es *cuánta* es, y si esa cifra crece de golpe en una unidad.\n\nLos umbrales (**Advertencia ≥**, **Revisión ≥**, **Alta ≥**) los pones tú con el botón **Editar**: no hay un número universal, depende de tu operación.\n\nLa columna **Verificación GPS** es una segunda opinión que mira el desplazamiento real de la unidad, no solo sus servicios. Lo único que pide acción es **“GPS > odóm.”**: el GPS prueba un recorrido mayor que el que registró el odómetro — casi siempre falta la lectura de cierre o el tablero se fotografió antes de tiempo. Y **⚠ GPS 60 %** significa señal con huecos: ahí el km de servicio está subestimado y la diferencia es engañosa.\n\nUn valor **negativo** no es un misterio: es GPS inflado u odómetro mal leído.",
      },
    ],
    comoHacer: [
      {
        titulo: "Registrar una carga de combustible",
        pasos: [
          "Pulsa “⛽ Nueva carga” y elige primero el tipo de combustible: la unidad de medida (galones, m³ o litros) y el precio referencial se ajustan solos.",
          "Elige la unidad. La lista viene partida en dos bloques —“Flota propia” y “Tercerizadas”— para que no confundas un bus tuyo con uno alquilado de placa parecida.",
          "Pon la fecha y el kilometraje del tablero. Ese kilometraje es lo que permite calcular el rendimiento: si lo dejas vacío, esa carga no aporta rendimiento a nada.",
          "Escribe la cantidad y el precio por unidad. Abajo aparece el Total calculado y, si la unidad ya tiene historial, su rendimiento histórico para comparar.",
          "Si el campo de cantidad se pone rojo con “⚠ Supera capacidad del tanque”, para y revisa antes de guardar.",
          "Completa grifo y conductor. No son obligatorios, pero son los dos filtros que después te dejan comparar precios entre grifos y consumo entre choferes.",
          "Guarda.",
        ],
        advertencia:
          "La urea (AdBlue) es un aditivo, no un combustible: entra al gasto pero NO se cuenta para rendimiento ni para galones. Está bien que así sea; no intentes cuadrarla con los km.",
      },
    ],
    relacionadas: [
      { etiqueta: "Costo real y rentabilidad por servicio", href: "/gastos" },
      { etiqueta: "Odómetro y lecturas", href: "/mantenimiento?tab=odometro" },
      { etiqueta: "Capacidad de tanque por unidad", href: "/vehiculos" },
      { etiqueta: "Precios de combustible para costeo", href: "/configuracion/costos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // NEUMÁTICOS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "neumaticos",
    rutas: ["/neumaticos"],
    titulo: "Neumáticos · vida útil, cocada y costo por kilómetro",
    resumen:
      "Lleva el control de cada llanta por posición en el vehículo: cuándo se instaló, con qué kilometraje, cuánta cocada le queda y cuánto te está costando cada kilómetro que rueda. Es el gasto de flota más fácil de perder de vista, porque no llega con una factura mensual.",
    paraQueSirve: [
      "Saber qué llanta está en cada posición de cada unidad, con un diagrama en vez de una lista.",
      "Que te avise cuando una llanta llega al 90 % de su vida útil, antes de que sea un problema en ruta.",
      "Comparar marcas de verdad, con el costo por kilómetro y no con el precio de compra.",
      "Controlar la cocada (los milímetros de dibujo) y la presión, que es lo que mira una fiscalización.",
      "Que el gasto en llantas aparezca en los totales de Gastos y de Finanzas.",
    ],
    conceptos: ["amortizacion", "prorrateo", "costo_directo", "centro_costo"],
    faqs: [
      {
        pregunta: "¿Por qué no puedo cargar un neumático a un servicio, si el combustible sí?",
        respuesta:
          "Porque **un neumático no es costo de un viaje: es costo de la unidad**, y está hecho así a propósito.\n\nUn juego de llantas te dura 60,000 o 80,000 kilómetros y cientos de servicios. Cargarle los S/ 4,800 completos al servicio del día que las compraste sería mentir dos veces: ese servicio saldría con pérdida y los 300 siguientes saldrían con una ganancia que no existe.\n\nLo correcto es **amortizarlo por kilómetro**: repartir el costo a lo largo de los kilómetros que la llanta va a rodar. Si un juego de S/ 4,800 rinde 60,000 km, cada kilómetro carga S/ 0.08, y un servicio de 180 km consume S/ 14.40 de llanta.\n\n**Pero ese reparto el ERP no lo hace solo, y es deliberado.** Repartir un costo compartido entre servicios se llama **prorrateo**, y el criterio de reparto (por kilómetro, por horas, por número de servicios, por ingresos) **es una decisión contable, no un dato**. Cambiar el criterio cambia qué cliente y qué ruta parecen rentables, así que el ERP prefiere no elegirlo por ti.\n\n**Esto tienes que definirlo con tu contador:** qué vida útil en kilómetros vas a asumir por tipo de llanta y con qué criterio la vas a repartir. Escríbelo, y aplícalo siempre igual — lo peor que puedes hacer es cambiar de criterio a mitad de año y comparar meses que ya no son comparables.\n\nMientras tanto el ERP te da la materia prima honesta: el **CPK**, el costo por kilómetro real de cada llanta.",
      },
      {
        pregunta: "¿Qué es el CPK y cómo lo leo?",
        respuesta:
          "**CPK = costo por kilómetro.** Es el precio que pagaste por esa llanta dividido entre los kilómetros que lleva rodados (kilometraje actual menos kilometraje de instalación).\n\nEs el único número que sirve para comparar marcas. Una llanta de S/ 1,200 que dura 80,000 km sale a **S/ 0.015 por km**. Una de S/ 900 que dura 45,000 km sale a **S/ 0.020**. La barata es la cara.\n\nEn la ficha de cada llanta el CPK se pinta en rojo cuando pasa de S/ 3 por kilómetro — ese umbral está pensado para avisar de un dato mal cargado, no de una llanta mala: un CPK así casi siempre significa que el kilometraje de instalación o el actual están mal.\n\nPara que el CPK signifique algo tienes que mantener el **Km actual** al día. Si lo cargaste el día de la instalación y no lo volviste a tocar, el CPK que ves es de ese día, no de hoy.",
      },
      {
        pregunta: "¿Qué es la cocada y cuándo tengo que cambiar la llanta?",
        respuesta:
          "La **cocada** son los milímetros de dibujo (las ranuras) que le quedan a la llanta. Una llanta nueva de bus trae del orden de 18 a 20 mm; a medida que rueda, baja.\n\nEl ERP te pide dos números —**cocada nueva** y **cocada actual**— y con eso calcula dos cosas:\n\n• **Desgaste**: cuántos milímetros perdió.\n• **Rendimiento**: cuántos kilómetros aguanta por milímetro. Es el mejor indicador de si la unidad está bien alineada y con la presión correcta: dos llantas de la misma marca en la misma unidad con rendimientos muy distintos te están diciendo que hay un problema mecánico, no de llanta.\n\nAdemás, cada llanta muestra su **vida útil en porcentaje** (kilómetros rodados sobre los kilómetros de vida útil que le asignaste):\n\n• verde hasta 70 %,\n• **amarillo 70–90 %** → programar rotación o inspección,\n• **rojo 90 % o más** → reemplazo, y sale en la alerta de arriba.\n\n**La profundidad mínima legal para circular la fija la norma y depende del eje y del tipo de vehículo. Confírmala con tu jefe de taller o con el reglamento vigente; el ERP no la impone.**",
      },
      {
        pregunta: "Si no se atan a un servicio, ¿dónde termina apareciendo el gasto en llantas?",
        respuesta:
          "En los dos sitios donde tiene que estar, contado **una sola vez**:\n\n• En **Gastos**, como una fila más de egreso con su fuente “🛞 Neumáticos”, atada a la placa. Si la abres, dice en letra chica: *“Costo de vehículo: no se imputa a un servicio”* — eso es esta explicación en una línea.\n• En **Finanzas**, dentro del total de egresos del período.\n\nEsto vale la pena decirlo claro porque **antes no era así**: los neumáticos quedaban fuera del cálculo unificado de egresos, y esa era exactamente la razón por la que la pantalla de Gastos y la de Finanzas te daban totales distintos y nadie sabía cuál creer. Hoy entran en el mismo cálculo que el combustible, el mantenimiento, la caja chica y los gastos generales.\n\nLo que **no** hacen es bajarle el margen a ningún servicio individual. Bajan el resultado del mes y el costo acumulado de esa placa, que es donde de verdad viven.",
      },
    ],
    relacionadas: [
      { etiqueta: "Todos los egresos", href: "/gastos" },
      { etiqueta: "Resultado del mes", href: "/finanzas" },
      { etiqueta: "Flota", href: "/vehiculos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SEGUROS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "seguros",
    rutas: ["/seguros"],
    titulo: "Seguros · pólizas de la flota y de la gente",
    resumen:
      "Un solo lugar para todas las pólizas: las de los vehículos (SOAT, CAT, Todo Riesgo, Responsabilidad Civil) y las de los trabajadores (SCTR Salud, SCTR Pensión, Vida Ley). Te dice qué vence, cuándo, y cuánto te cuesta al año y al mes.",
    paraQueSirve: [
      "No perder de vista un vencimiento que deja una unidad o un trabajador sin cobertura.",
      "Saber cuánto te cuesta el bloque de seguros: prima anual total y cuota mensual total.",
      "Separar lo obligatorio de lo complementario, para saber qué es riesgo legal y qué es decisión comercial.",
      "Tener a mano el número de póliza, la aseguradora y el PDF cuando hay un siniestro.",
      "Ver en la franja de 60 días qué toca renovar antes de que te agarre encima.",
    ],
    conceptos: ["vencimiento", "devengado", "periodo_contable", "cuentas_por_pagar"],
    faqs: [
      {
        pregunta: "¿Cuáles son obligatorios y qué pasa de verdad si se me vence uno?",
        respuesta:
          "El ERP los marca con 🔴 **Obligatorios**. Son de dos familias distintas:\n\n**Del vehículo**\n• **SOAT** — sin él la unidad no puede circular: multa, retención de la unidad y, si hay accidente, los daños a terceros los pagas tú.\n• **CAT** — la alternativa al SOAT en algunas provincias.\n\n**De las personas** (estos los fiscaliza SUNAFIL, no la policía de tránsito)\n• **SCTR Salud** y **SCTR Pensión** — obligatorios porque el transporte es actividad de riesgo. Si un trabajador se accidenta sin SCTR vigente, la atención y la indemnización las asume la empresa, más la multa.\n• **Vida Ley (D.L. 688)** — el seguro de vida que la empresa contrata para su trabajador. En **Personal administrativo** el ERP te lanza el aviso cuando alguien llega a los 4 años de antigüedad, que es el hito clásico que se pasa por alto. En **Conductores** ese aviso automático no existe: ahí tienes la casilla Vida Ley con su fecha de vencimiento, y la fecha sí entra al semáforo, pero el recordatorio de los 4 años lo tienes que llevar tú.\n\nLos complementarios (🔵 Todo Riesgo, Responsabilidad Civil, seguro de carga, patrimonio) no son exigencia legal, pero **sí suelen ser exigencia del cliente corporativo en la licitación**: una minera o una empresa grande te va a pedir póliza de responsabilidad civil con un monto mínimo antes de firmar.\n\n**Los montos de multa y las coberturas exactas dependen de la norma vigente y de tu póliza. Confírmalos con tu corredor de seguros y con tu asesor laboral** — el ERP te avisa de la fecha, no interpreta el contrato.",
      },
      {
        pregunta: "¿Pongo Prima total o Cuota mensual? ¿Qué diferencia hay?",
        respuesta:
          "• **Prima total** es lo que cuesta la póliza por todo el período, normalmente un año. Es el precio del contrato.\n• **Cuota mensual** es lo que le pagas a la aseguradora cada mes si la financiaste en cuotas.\n\nPuedes llenar las dos. Los KPIs de arriba las suman por separado: **Prima anual** te dice cuánto pesa el bloque de seguros en el año, y **Cuota mensual** cuánto sale de caja este mes.\n\nUna cosa que conviene tener en la cabeza: si pagaste S/ 12,000 de golpe en enero por una póliza anual, contablemente ese gasto **no es todo de enero** — le corresponde S/ 1,000 a cada mes del año. Eso es lo que se llama devengar. Cargarlo entero a enero hace que enero se vea pésimo y los once meses siguientes se vean mejores de lo que son.\n\n**Cómo se registra ese reparto en tus libros lo define tu contador.** Esta pantalla lleva el control de la póliza; el asiento contable es otra cosa.",
      },
      {
        pregunta: "El SOAT ya lo cargué en Documentos Vehiculares. ¿Lo cargo otra vez aquí?",
        respuesta:
          "Sí, y no es duplicar: son dos preguntas distintas sobre el mismo papel.\n\n• En **Documentos Vehiculares** el SOAT es un **requisito para circular**. Lo que importa ahí es la fecha: si vence, la unidad pasa a “No apto” y no debería salir.\n\n• Aquí el SOAT es una **póliza con un costo y una aseguradora**. Lo que importa es cuánto te cuesta, con quién está contratada, con qué broker y cuánto suma al total de primas del año.\n\nSi solo te interesa el control operativo, con Documentos Vehiculares te basta. Si quieres saber cuánto gasta AFA en seguros al año y negociar la renovación con números, cárgalo también aquí. Lo que **no** debes hacer es llevar dos fechas de vencimiento distintas para el mismo papel: cuando renueves, actualiza las dos.",
      },
    ],
    relacionadas: [
      { etiqueta: "Documentos vehiculares", href: "/documentos-vehiculares" },
      { etiqueta: "Conductores (SCTR y Vida Ley)", href: "/conductores" },
      { etiqueta: "Personal administrativo", href: "/personal-administrativo" },
      { etiqueta: "Pago de las pólizas (CxP)", href: "/tesoreria" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CONDUCTORES
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "conductores",
    rutas: ["/conductores"],
    titulo: "Conductores · licencias, contratos y cumplimiento",
    resumen:
      "La ficha de cada chofer: sus datos, su licencia MTC, su contrato, su SCTR, su examen médico y su PIN para entrar a la app del conductor. La franja roja de arriba es la que te dice quién NO puede manejar hoy.",
    paraQueSirve: [
      "Saber en un vistazo quién tiene la licencia vigente y quién no puede subirse a una unidad.",
      "No exponerte a una multa de SUNAFIL por un SCTR o un examen médico vencido.",
      "Controlar los contratos de plazo fijo, que si se vencen y la persona sigue trabajando se convierten en indefinidos.",
      "Dar y quitar el acceso a la app del conductor con un PIN de 4 dígitos.",
      "Tener el teléfono y el DNI a mano cuando hay una incidencia en ruta.",
    ],
    conceptos: ["vencimiento", "recibo_honorarios", "costo_directo", "centro_costo"],
    faqs: [
      {
        pregunta: "¿Qué es esa franja roja de “Riesgo de multa SUNAFIL” y qué documentos mira?",
        respuesta:
          "Es la alerta que te dice, en una línea, dónde estás expuesto hoy. Mira cuatro cosas:\n\n• **Licencia de conducir vencida** — esa persona **no puede operar una unidad**. Es lo más grave en lo inmediato: si sale y la intervienen, la papeleta es del chofer pero la responsabilidad operativa y el servicio caído son tuyos. La licencia se controla con 60 días de anticipación, no 30, porque el trámite MTC toma su tiempo.\n\n• **Contrato de plazo fijo vencido** — riesgo de *desnaturalización* (te lo explico en la siguiente pregunta).\n\n• **SCTR vencido** — el Seguro Complementario de Trabajo de Riesgo es obligatorio en transporte. Sin él, un accidente laboral lo termina pagando la empresa, y encima hay multa.\n\n• **Examen médico ocupacional o psicosométrico vencido** — es requisito de seguridad y salud en el trabajo, y en transporte además es requisito para conducir.\n\nLos montos que aparecen en la alerta son **referencias en UIT para dimensionar el riesgo, no una liquidación**. La multa real depende del tamaño de la empresa, del número de trabajadores afectados y de la gradualidad que aplique el inspector. **Confírmalo con tu asesor laboral.**",
      },
      {
        pregunta: "El ERP dice “riesgo de desnaturalización”. ¿Qué significa eso en cristiano?",
        respuesta:
          "Significa esto: si un trabajador tiene **contrato a plazo fijo**, se le vence el contrato, y **sigue viniendo a trabajar** sin que le renueves nada, la ley entiende que ese contrato ya no es temporal — **pasa a ser indefinido**.\n\nEn la práctica: dejas de tener un contrato con fecha de fin y pasas a tener un trabajador permanente, con todo lo que eso implica el día que quieras terminar la relación. Y no es algo que se pueda arreglar retroactivamente firmando un papel después.\n\nPor eso el ERP te lo marca en rojo el día que el contrato vence, no después. Si vas a renovar, renueva antes de la fecha; si no vas a renovar, la desvinculación tiene que ocurrir al vencimiento.\n\n**Esto lo tiene que ver tu asesor laboral, no el ERP.** El sistema solo te avisa de la fecha; qué hacer con ella es una decisión legal.",
      },
      {
        pregunta: "¿Para qué es el PIN de 4 dígitos?",
        respuesta:
          "Es la llave del conductor para entrar a **su** aplicación desde el celular, sin usuario ni contraseña de correo. Con ese PIN el chofer ve sus servicios del día, hace el check-in y el check-out de jornada con la foto del odómetro, y reporta incidencias.\n\nDos detalles prácticos, y el primero importa mucho:\n\n• Cuando editas a un conductor, el campo **PIN de acceso (4 dígitos)** llega con su PIN actual ya escrito. **Si lo borras y guardas, esa persona se queda sin PIN y no podrá entrar a la app.** Para cambiárselo, escribe el nuevo encima; para dejarlo como está, no toques el campo. (El recuadro dice “Déjalo vacío para no modificar el PIN actual”, pero en la práctica el campo nunca llega vacío: vaciarlo a mano sí borra el PIN.)\n• La casilla **“Activo en app conductor”** es el interruptor real, y es el que debes usar para cortar el acceso. Desmarcarla lo deja fuera sin borrar nada —le sale “Acceso no activado. Llama a central.”— y es lo que haces cuando alguien deja de trabajar contigo o está de vacaciones. Volver a marcarla lo devuelve tal cual estaba.\n\nEse check-in y check-out son los que alimentan la pantalla de **Auditoría km**: sin ellos no hay “km de jornada” con qué comparar.",
      },
      {
        pregunta: "¿Aquí se registra lo que le pago al conductor por un servicio?",
        respuesta:
          "No. Esta pantalla es la ficha de la persona: sus papeles y su estado. El dinero va por otro lado, y depende de cómo le pagues:\n\n• **Pago por servicio** (lo que le das al chofer por cubrir un viaje) → se registra en **Gastos**, con la categoría *Conductor por servicio* y eligiendo tanto al conductor como la reserva. Así ese pago le baja el margen a ese servicio en concreto, que es lo correcto: es un costo directo del viaje.\n\n• **Sueldo de planilla** → va en **Tesorería → pestaña Planilla y admin.**, junto con los demás gastos que no tienen factura de proveedor detrás.\n\n• **Viáticos y peajes que le entregas para el viaje** → eso es **Caja Chica**: se le entrega dinero a rendir y él devuelve los comprobantes.\n\nEl **Tipo de contrato** que pones en esta ficha (planilla, plazo fijo, recibo por honorarios, service, eventual) es lo que te dice cuál de los tres caminos corresponde.",
      },
    ],
    relacionadas: [
      { etiqueta: "Pagos por servicio (Gastos)", href: "/gastos" },
      { etiqueta: "Planilla y sueldos", href: "/tesoreria" },
      { etiqueta: "Entregas a rendir", href: "/caja-chica" },
      { etiqueta: "Pólizas SCTR y Vida Ley", href: "/seguros" },
      { etiqueta: "Auditoría de kilómetros", href: "/auditoria-jornada" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PERSONAL ADMINISTRATIVO
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "personal",
    rutas: ["/personal-administrativo"],
    titulo: "Personal administrativo · el equipo de oficina",
    resumen:
      "La misma ficha de cumplimiento que Conductores, pero para el equipo que no maneja: Gerencia, Administración, Contabilidad / Finanzas, Operaciones, Comercial / Ventas, RRHH, Logística / Flota, Tecnología y Legal. Contratos, SCTR, exámenes, AFP u ONP y las alertas de SUNAFIL.",
    paraQueSirve: [
      "Tener el legajo mínimo de cada persona: DNI, cargo, departamento, fecha de ingreso y contrato.",
      "Controlar los contratos de plazo fijo antes de que se te venzan encima.",
      "Guardar el dato de AFP u ONP y el número de ESSALUD, que es lo que se declara en el T-Registro.",
      "Que te avise cuando alguien cumple 4 años y le corresponde el seguro Vida Ley.",
      "Filtrar por departamento para saber cuánta gente tienes en cada área.",
    ],
    conceptos: ["vencimiento", "recibo_honorarios", "cuentas_por_pagar", "devengado"],
    faqs: [
      {
        pregunta: "¿Qué diferencia hay con la pantalla de Conductores? ¿Por qué son dos?",
        respuesta:
          "Porque el chofer tiene tres cosas que el personal de oficina no tiene, y que son justo las que más se vencen:\n\n• **Licencia de conducir MTC** con su categoría y su vencimiento.\n• **Certificado psicosométrico**, que es requisito para conducir.\n• **PIN de la app del conductor**, para hacer check-in de jornada desde el celular.\n\nAdemás, un conductor se asigna a servicios y a unidades; una asistente contable no.\n\nTodo lo demás —contrato, SCTR, examen médico, AFP/ONP, Vida Ley, alertas SUNAFIL— funciona exactamente igual en las dos pantallas. Si contratas a alguien que a veces maneja, va en Conductores: es la ficha más completa.",
      },
      {
        pregunta: "¿Qué es esto de AFP, ONP y T-Registro, y para qué lo guardo aquí?",
        respuesta:
          "Es el **sistema de pensiones** al que aporta cada trabajador, y hay tres situaciones:\n\n• **AFP** — sistema privado. El trabajador eligió una administradora (Integra, Prima, Profuturo, Habitat) y esa es la que se declara.\n• **ONP** — sistema nacional, el del Estado.\n• **Sin sistema** — es el caso del que emite recibo por honorarios: no está en planilla, así que no hay aporte de pensiones de este tipo.\n\nEl **T-Registro** es el registro de trabajadores que la empresa mantiene ante SUNAT: quién trabaja aquí, desde cuándo, en qué régimen y en qué sistema pensionario. Guardar el dato aquí es para tenerlo a mano cuando toca declarar o cuando alguien te lo pide; **el ERP no declara nada ante SUNAT y no calcula la planilla**.\n\n**Quién va en qué régimen, cómo se declara y qué aportes corresponden lo define tu contador.** Esta pantalla es el legajo, no la liquidación.",
      },
      {
        pregunta: "Me sale “Seguro Vida Ley obligatorio — este trabajador tiene 4 años”. ¿Qué hago?",
        respuesta:
          "Es un aviso, no un error. El **D.L. 688** obliga a la empresa a contratar un seguro de vida para sus trabajadores, y el hito de los 4 años de antigüedad es el clásico que se pasa por alto porque no lo recuerda nadie.\n\nQué hacer:\n\n1. Contrata la póliza con tu corredor.\n2. Vuelve a la ficha de esa persona, marca la casilla **Vida Ley** y pon la fecha de vencimiento de la póliza. A partir de ahí el vencimiento entra al semáforo como cualquier otro.\n3. Si quieres además controlar cuánto te cuesta, carga la póliza en **Seguros**.\n\n**Ojo:** la norma cambió en los últimos años respecto de desde cuándo corresponde el seguro. **Confirma con tu asesor laboral desde qué momento te aplica hoy** — el aviso de los 4 años es una ayuda de memoria, no una interpretación legal.",
      },
      {
        pregunta: "¿Los sueldos se pagan desde aquí?",
        respuesta:
          "No. Aquí está **quién** trabaja contigo y con qué papeles. **Cuánto** se le paga y cuándo va en **Tesorería → pestaña Planilla y admin.**\n\nEsa separación es a propósito: los sueldos no llegan con una factura de proveedor detrás, pero igual salen del banco y tienen que pasar por la aprobación de gerencia y entrar al lote de pago del mes como cualquier otra obligación. Por eso viven junto al resto del gasto, no en el legajo.\n\nY el botón **🔁 Generar mes siguiente** de esa pantalla te ahorra volver a teclearlos: copia al mes que viene los gastos del mes que estás mirando que estén marcados como **recurrentes** y ya **aprobados**. Los copia siempre como pendientes de aprobar, para que un sueldo o un alquiler que cambió de importe pase por el ojo de alguien antes de volver a ser una obligación.",
      },
    ],
    relacionadas: [
      { etiqueta: "Planilla y gastos administrativos", href: "/tesoreria" },
      { etiqueta: "Conductores", href: "/conductores" },
      { etiqueta: "Pólizas SCTR y Vida Ley", href: "/seguros" },
      { etiqueta: "Contratos y legajos", href: "/documentos" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOCUMENTOS DE EMPRESA · VENCIMIENTOS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "documentos",
    rutas: ["/documentos", "/vencimientos"],
    titulo: "Documentos de empresa · el archivador digital",
    resumen:
      "Es el archivador de la empresa: contratos con clientes, documentos de seguridad y salud (SST), capacitaciones, permisos, temas legales y guías de remisión. Cada archivo puede llevar fecha de vencimiento y entra al mismo semáforo que el resto del ERP.",
    paraQueSirve: [
      "Dejar de buscar el contrato de un cliente en el correo de hace ocho meses.",
      "Atar un documento a quien corresponde: un cliente, un proveedor, un conductor o un servicio.",
      "Que un contrato o un permiso con fecha de fin te avise antes de vencerse.",
      "Tener el expediente listo cuando llega una auditoría del cliente o una fiscalización.",
    ],
    conceptos: ["vencimiento", "guia_remision", "comprobante", "conformidad"],
    faqs: [
      {
        pregunta: "¿Qué va aquí y qué va en Documentos Vehiculares? Me pierdo entre las dos.",
        respuesta:
          "La regla es de quién es el papel:\n\n• **Documentos Vehiculares** → papeles de una **placa**: SOAT, CITV, tarjeta de propiedad, habilitación SUTRAN, permiso MTC, certificado de GNV o GLP. Esos determinan si la unidad puede salir a trabajar.\n\n• **Conductores** y **Personal administrativo** → papeles de una **persona**: licencia, contrato, SCTR, examen médico. Se cargan como fechas dentro de la ficha de esa persona.\n\n• **Aquí (Documentos de empresa)** → todo lo demás, que es lo que no tiene ficha propia: el **contrato con un cliente**, el plan anual de **SST**, las constancias de **capacitación**, los **permisos** municipales, los documentos **legales**, las **guías de remisión** y lo **interno**.\n\nSi dudas, pregúntate: ¿este papel es de una placa, de una persona, o de la empresa? La tercera opción es esta pantalla.\n\nEn el menú, el grupo **Control** agrupa Vencimientos y Documentos como el bloque de “papeles que caducan”, pero el semáforo de cada familia vive en su propia pantalla: los de flota en Documentos Vehiculares, los de gente en Conductores y Personal, los de empresa aquí.",
      },
      {
        pregunta: "¿Qué significa el semáforo y qué pasa si un documento vence?",
        respuesta:
          "El semáforo se calcula solo con la fecha de vencimiento que pusiste, y es el mismo criterio en todo el ERP:\n\n• **Vigente** — falta más de un mes.\n• **Por vencer** — quedan 30 días o menos.\n• **Vencido** — ya se pasó.\n\nQué pasa depende del documento, y por eso el ERP no puede decidir por ti:\n\n• Un **contrato con cliente vencido** normalmente no te para la operación, pero sí te deja sin respaldo el día que hay un reclamo o un impago. Y algunos clientes corporativos no pagan una factura si el contrato marco venció.\n• Un **permiso municipal o sectorial vencido** sí puede pararte, igual que un papel de flota.\n• Un **documento de SST vencido** (plan anual, capacitación, examen) es de lo primero que revisa una fiscalización, y es exactamente lo que no se puede improvisar cuando ya llegó el inspector.\n\n**Un documento sin fecha de vencimiento entra como “Vigente” y nunca te va a avisar de nada.** Si el papel caduca, pon la fecha; si no caduca (una escritura, un acta), déjala vacía a propósito.",
      },
      {
        pregunta: "Marqué “Documento privado”. ¿Eso lo protege?",
        respuesta:
          "Con cuidado: **la casilla clasifica, no blinda.**\n\nLo que hace es marcar el documento como interno en el listado y contarlo en el KPI de “Privados”, para que sepas qué parte de tu archivador es confidencial.\n\nLo que **no** hace es proteger el archivo en sí: el enlace del archivo subido es un enlace directo. Trátalo como tratarías un enlace de Drive que ya está compartido — **no lo pegues en un correo, un WhatsApp o una cotización si el contenido es sensible.**\n\nY una recomendación práctica: no subas aquí cosas que no deberían estar en un archivador general. Los comprobantes de gasto con foto (tickets, peajes, vouchers) tienen su propio sitio en **Caja Chica**, donde el almacenamiento sí es privado y los archivos se abren con un enlace temporal.",
      },
    ],
    relacionadas: [
      { etiqueta: "Documentos vehiculares", href: "/documentos-vehiculares" },
      { etiqueta: "Conductores", href: "/conductores" },
      { etiqueta: "Personal administrativo", href: "/personal-administrativo" },
      { etiqueta: "Comprobantes de gasto", href: "/caja-chica" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURACIÓN
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "configuracion",
    rutas: ["/configuracion"],
    titulo: "Configuración · los datos que el ERP da por ciertos",
    resumen:
      "Es donde se ajusta lo que el resto del sistema usa sin preguntar: los datos de la empresa que salen impresos en las cotizaciones, los precios y rendimientos con los que se calcula un costo, los avisos que salen por WhatsApp, la asistente ELIA y los textos legales.",
    paraQueSirve: [
      "Que el RUC, la razón social y el logo salgan bien en cada PDF que ve un cliente.",
      "Actualizar el precio del combustible y ver al instante cómo mueve el costo por kilómetro.",
      "Decidir qué avisos se mandan, cuándo y a qué teléfono.",
      "Poner un tope de gasto mensual a la asistente ELIA.",
      "Dejar por escrito quién cambió un parámetro de costo y por qué.",
    ],
    conceptos: ["ruc", "sunat", "igv", "centro_costo", "tipo_cambio"],
    faqs: [
      {
        pregunta: "¿Qué se cambia en cada una de estas pantallas?",
        respuesta:
          "Son siete y hacen cosas muy distintas:\n\n• **Perfil Empresa** — nombre, razón social, RUC, régimen tributario, dirección, teléfono, logo, colores, moneda y zona horaria. **Es lo que se imprime en las cotizaciones y los reportes que ve el cliente.**\n• **Costos** — precios de combustible y parámetros de cada tipo de vehículo. De aquí sale el costo por kilómetro que usa el cotizador.\n• **Usuarios** — quién entra al ERP, con qué rol y a qué módulos. Tiene su propia ficha de ayuda.\n• **ELIA** — encender o apagar la asistente, elegir el modelo y ponerle un límite de gasto al mes.\n• **Alertas y Mensajes** — el directorio de a quién se avisa y qué mensajes salen por WhatsApp, correo o push.\n• **Sistema** — parámetros técnicos, **solo lectura**.\n• **Páginas Legales** — el texto de la política de privacidad que se publica en tu web, con editor y vista previa. Es la página pública que el ERP sirve en /privacidad.\n\nLa regla general: si el cambio lo ve un cliente, está en Perfil o en Legales. Si el cambio mueve un número, está en Costos.",
      },
      {
        pregunta: "En Perfil me pide RUC y régimen tributario. ¿Dónde se usan?",
        respuesta:
          "El **RUC** es tu identificación ante SUNAT, once dígitos. El ERP valida que sean once y lo imprime en cotizaciones, reportes y documentos. Un RUC mal escrito en una cotización es una cotización que el área de compras del cliente te devuelve.\n\nLa **razón social** es el nombre legal, tal como figura en SUNAT (por ejemplo “AFA TOURS S.A.C.”), y no siempre es igual al nombre comercial con el que te conocen. En los papeles va la razón social.\n\nEl **régimen tributario** es un desplegable con cuatro opciones, escritas como las nombra SUNAT: **General** (Régimen General), **RMT** (Régimen MYPE Tributario), **RER** (Régimen Especial de Renta) y **RUS** (Nuevo RUS). Dentro del ERP es informativo: no cambia ningún cálculo. Está para que quede constancia y para que quien arme un documento sepa en qué régimen estás.\n\n**Qué régimen te corresponde y qué obligaciones trae lo define tu contador.** Cambiar el desplegable aquí no cambia nada ante SUNAT.",
      },
      {
        pregunta: "En Costos, ¿si cambio el precio del diésel cambia algo de inmediato?",
        respuesta:
          "Sí, y ese es el punto: **los cambios se aplican en tiempo real al Cotizador y a las Cotizaciones nuevas**. Las cotizaciones ya emitidas no se tocan — quedan con el precio que tenían el día que las hiciste, que es lo correcto.\n\nLa pantalla tiene tres pestañas: **⛽ Combustible** (el precio por tipo), **🚌 Flota / Vehículos** (rendimiento y parámetros por tipo de unidad) y **📋 Historial**.\n\nDos cosas que vale la pena aprovechar:\n\n• La tabla **“Impacto en costo S/km”** te muestra, con los precios que acabas de poner, cuánto le cuesta el kilómetro a cada tipo de unidad y cuánto sale un día de 100 km. Es la forma rápida de ver si un ajuste de precio te deja fuera de mercado.\n• El campo **Motivo del cambio** no es decorativo: se guarda en el historial con tu correo y la fecha. Escribe algo útil (“Precio OSINERGMIN semana 20”), porque dentro de seis meses la pregunta va a ser por qué el costeo cambió en mayo.\n\nLos precios de referencia los puedes verificar en FacilitO de OSINERGMIN, que está enlazado en la misma pantalla.",
      },
      {
        pregunta: "¿Por qué la pantalla “Sistema” no me deja cambiar nada?",
        respuesta:
          "Porque ahí no hay preferencias: hay **conexiones**. Son las claves y direcciones con las que el ERP habla con Supabase, con el proveedor de correo, con WhatsApp o con Google Maps.\n\nEsas se guardan como variables de entorno en el servidor, no en una tabla que el ERP pueda escribir, por una razón simple: **una clave de servicio que se pudiera editar desde el navegador sería una clave que cualquiera con acceso a esa pantalla podría copiar.** La pantalla te las muestra en modo lectura para que sepas qué está activo y qué falta.\n\nCambiarlas es tarea de quien administra el despliegue del sistema. Si algo aparece como faltante y una función no anda (por ejemplo, no salen los correos), esa lista es justamente el sitio donde mirar antes de llamar.",
      },
    ],
    relacionadas: [
      { etiqueta: "Usuarios y permisos", href: "/configuracion/usuarios" },
      { etiqueta: "Perfil de la empresa", href: "/configuracion/perfil" },
      { etiqueta: "Costos operativos", href: "/configuracion/costos" },
      { etiqueta: "Tarifario", href: "/tarifario" },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // USUARIOS Y PERMISOS
  // ══════════════════════════════════════════════════════════════════════════
  {
    clave: "usuarios",
    rutas: ["/configuracion/usuarios"],
    titulo: "Usuarios · quién entra y qué puede ver",
    resumen:
      "Aquí se crean las cuentas del ERP, se les da un rol y se decide, módulo por módulo, qué pantallas puede abrir cada persona. Es la pantalla que define quién aprueba un pago y quién solo lo registra.",
    paraQueSirve: [
      "Crear la cuenta de alguien nuevo y decidir a qué llega y a qué no.",
      "Separar quién REGISTRA un gasto de quién lo APRUEBA, que es el control interno más básico.",
      "Cortar el acceso de alguien que ya no trabaja contigo, sin borrar lo que hizo.",
      "Cambiarle la contraseña a quien la perdió, sin pedírsela.",
      "Ver de un vistazo cuántos administradores tienes (deberían ser pocos).",
    ],
    conceptos: ["estado_aprobacion", "cuentas_por_pagar", "lote_pago", "rendicion", "caja_chica"],
    faqs: [
      {
        pregunta: "¿Qué hace cada uno de los tres roles? Sobre todo, ¿qué es un “gerente”?",
        respuesta:
          "Hay **tres roles**, y la diferencia entre ellos es qué puede hacer con el dinero:\n\n**👤 Operador** — el rol normal. Registra: carga una factura de GRIJALVA TOURS, anota una carga de combustible, crea una reserva, rinde su caja chica. **No aprueba nada.** Solo ve los módulos que le marques uno por uno.\n\n**✅ Gerente** — es el rol nuevo, y existe para resolver un problema muy concreto: *alguien tiene que dar el visto bueno al gasto, y no tiene por qué ser el administrador del sistema.*\n\nUn gerente **aprueba gasto**:\n• las **facturas de proveedores** (Cuentas por pagar): las pasa de Pendiente a Aprobada, o las rechaza con motivo;\n• la **planilla y los gastos administrativos**;\n• los **lotes de pago**, que es el archivo que se sube al banco;\n• las **rendiciones de caja chica**.\n\nY lo que **no** es: no es administrador del sistema. **Sigue sujeto a los permisos por módulo igual que un operador** — si no le marcas Tesorería, no entra a Tesorería por más gerente que sea. Aprobar es una facultad; entrar es un permiso, y son cosas distintas.\n\n**👑 Administrador** — manda en el sistema. **Entra a todos los módulos automáticamente, sin que le marques ni una casilla** (por eso su panel de permisos solo muestra el aviso amarillo). Además es el único que puede crear usuarios, cambiar contraseñas y eliminar cuentas. Y también aprueba gasto, como el gerente.\n\nLa regla sana: **muchos operadores, uno o dos gerentes, y los administradores mínimos indispensables.**",
      },
      {
        pregunta: "¿Por qué el usuario que acabo de crear casi no ve nada?",
        respuesta:
          "Porque nace **casi sin permisos, a propósito**. Un usuario nuevo que no sea administrador arranca solo con lo mínimo (Dashboard, Cotizaciones y Clientes) y nada más.\n\nEs lo correcto: es más seguro empezar cerrado y abrir lo que haga falta que empezar abierto y darte cuenta en agosto de que el practicante ve las cuentas por pagar.\n\nPara abrirle lo que necesita: pulsa **⚙️ Permisos** en su tarjeta, marca los módulos, y **pulsa “💾 Guardar permisos”** — mientras no guardes, las casillas están marcadas solo en tu pantalla. Tienes atajos: **Todos** / **Ninguno** arriba, y **Activar todo** por grupo (Flota, Finanzas, Documentos…).\n\nSi es administrador no hace falta nada: entra a todo desde el primer minuto.",
      },
      {
        pregunta: "¿Cuál es la diferencia entre desactivar a alguien y eliminarlo?",
        respuesta:
          "**Desactivar** (botón rojo “Desactivar”) le corta el acceso y nada más. La cuenta queda ahí, en gris, con sus permisos intactos, y todo lo que esa persona registró sigue existiendo con su nombre. Si vuelve, lo reactivas y sigue donde estaba.\n\n**Eliminar** borra la cuenta de forma permanente. Por eso te pide **tu propia contraseña de administrador** para confirmarlo: es la única acción de esta pantalla que no se puede deshacer.\n\n**Usa desactivar casi siempre.** Cuando alguien deja la empresa lo que necesitas es que no pueda entrar, no que desaparezca su rastro — el día que revises quién aprobó una factura de S/ 4,300 en marzo, vas a querer que ese nombre siga ahí.\n\nY ojo: no puedes eliminarte ni cambiarte la contraseña a ti mismo desde aquí. Tu propia tarjeta viene marcada con **👤 Tú** y sin esos botones, para que no te quedes fuera de tu propio ERP.",
      },
      {
        pregunta: "Le marqué el módulo pero la persona sigue sin ver la pantalla. ¿Qué pasó?",
        respuesta:
          "Revisa estas cuatro cosas, en orden:\n\n1. **¿Pulsaste “💾 Guardar permisos”?** Es lo más frecuente. Marcar las casillas no guarda nada por sí solo; tiene que salirte el “✅ Permisos guardados”.\n2. **¿La persona recargó la sesión?** Los permisos se leen al navegar; si tiene la pantalla abierta desde antes, que refresque o vuelva a entrar.\n3. **¿La cuenta está activa?** Una cuenta desactivada se cierra sola al intentar entrar, tenga los permisos que tenga.\n4. **¿Marcaste el módulo correcto?** Varias pantallas del menú **no tienen permiso propio**: comparten el de otra. Las que más confunden:\n   • **Docs. Vehiculares** entra con el permiso de **Vehículos**.\n   • **Auditoría km** entra con el de **Combustible**.\n   • **Cotizador** y **Plantillas PDF** entran con el de **Cotizaciones**.\n   • **Calendario** entra con el de **Dashboard**.\n   • **Tercerizadas** entra con el de **Proveedores**, y **Salud del GPS** con el de **Monitoreo**.\n   • En Configuración, **Perfil Empresa**, **ELIA**, **Alertas y Mensajes**, **Sistema** y **Páginas Legales** entran todas con el permiso **Configuración**. **Costos** y **Usuarios** sí tienen el suyo.",
      },
    ],
    comoHacer: [
      {
        titulo: "Crear un gerente que apruebe pagos",
        pasos: [
          "Entra a Configuración → Usuarios y pulsa “+ Nuevo usuario”.",
          "Llena nombre, correo y una contraseña de al menos 6 caracteres. Esa contraseña es provisional: díctasela y pídele que te avise cuando entre.",
          "En Rol elige “Gerente”.",
          "Pulsa “✅ Crear usuario”. La cuenta nace activa pero con permisos mínimos.",
          "En su tarjeta pulsa “⚙️ Permisos” y abre el grupo 💰 Finanzas. Marca al menos “Cuentas por Pagar” y “Caja Chica”: son los módulos donde va a aprobar.",
          "Marca también lo que necesite mirar para decidir — normalmente Gastos y Finanzas.",
          "Pulsa “💾 Guardar permisos” y confirma que aparece el mensaje de guardado.",
          "Pídele que entre y verifica con él que ve el botón de aprobar en Cuentas por pagar.",
        ],
        advertencia:
          "No le des rol de Administrador solo para que pueda aprobar. Aprobar gasto es exactamente lo que hace el rol Gerente; el administrador además puede crear y borrar usuarios, y eso es otra clase de poder.",
      },
    ],
    relacionadas: [
      { etiqueta: "Aprobación de facturas y lotes", href: "/tesoreria" },
      { etiqueta: "Aprobación de rendiciones", href: "/caja-chica" },
      { etiqueta: "Perfil de la empresa", href: "/configuracion/perfil" },
    ],
  },
];
