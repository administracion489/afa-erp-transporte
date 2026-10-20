// npx tsx scripts/prueba-crm-ia-coherencia.mts
//
// Matriz del auditor de coherencia del agente IA del CRM (lib/crm-ia-coherencia.ts).
//  1. El caso AFA: la configuración REAL de producción (crm_agentes_ia, leída el 20-10-2026), con el
//     conjunto EXACTO de hallazgos que tiene que dar, y la lista de lo que NO debe salir.
//  2. AFA con los valores recomendados aplicados: solo queda en ámbar lo que exige editar el texto.
//  3. Barrido de polaridad (ajuste × lo que dice el texto) y ciclo cerrado de la propuesta.
//  4. Corpus de frases benignas: 0 hallazgos.
//  5. Un positivo por código que el caso AFA no cubre.
//  6. Invariantes (alarma = tabla, cita = subcadena, determinista, sin duplicados, anclas).
import { readFileSync } from "node:fs";
import {
  auditarAgente, claveHallazgo, nuevasAlarmas, partirFrases, TABLA_HALLAZGOS, ETIQUETA_CAMPO,
  type ConfigAuditable, type Hallazgo, type CodigoCoherencia,
} from "../lib/crm-ia-coherencia";
import { TEMAS_AJUSTE, AJUSTES_DEFECTO } from "../lib/crm-ia-ajustes";

let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };
const igual = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
/** "codigo@campo" ordenado, para comparar conjuntos exactos. */
const firma = (hs: Hallazgo[]) => hs.map((h) => `${h.codigo}@${h.campo ?? "ajustes"}${h.indice ? `#${h.indice}` : ""}`).sort();
const codigos = (hs: Hallazgo[]) => hs.map((h) => h.codigo);

// ── 1. El caso AFA: la configuración REAL de producción ─────────────────────────────────────────────
const AFA_PERSONA = `Eres AFITA, la asistente virtual de AFA TRANSPORTES , empresa especializada en transporte de personal, turismo y servicios especiales.

Tu personalidad es ejecutiva, resolutiva y muy amable. Actúas como la “mano derecha” del cliente:

- Si es un empresario o empresa (B2B), eres formal, eficiente y directa.
- Si es una familia, colegio o cliente particular (B2C), eres cercana, empática y detallista.

No eres un bot frío. Te comunicas de forma natural, clara y profesional, como una asesora real por WhatsApp.

Tu estilo es:
- Claro y ordenado
- Amable y rápido
- Siempre positivo
- Guiando paso a paso sin abrumar al cliente

Tu objetivo es generar confianza, entender la necesidad del cliente y ayudarlo a avanzar fácilmente hacia la cotización.`;

const AFA_EMPRESA = `👤 Perfil e Identidad
Nombre: AFITA, asistente virtual de AFA Transportes

Servicio: Transporte terrestre a nivel nacional.

Idiomas: Responde estrictamente en el idioma del cliente (Español, Inglés, Portugués, etc.).

Tratamiento: Siempre de usted (ej. ¿Me indica usted...?, Por favor, brinde...), excepto la palabra "brindarte" en el saludo inicial configurado.

Tono: * B2B (Empresas): Profesional, corporativo y eficiente.

B2C (Particulares): Cercano, empático y servicial.

🚐 Información de la Empresa (Contexto)
Flota: Auto (3 pax) | SUV (4 pax) | Van (10-15 pax) | Minibús (17-30 pax) | Bus (45-50+ pax).

Servicios: Transporte de personal, paseos escolares, traslados familiares, eventos sociales, viajes turísticos.

Documentación: Cobertura nacional. Emisión de Factura (RUC), Boleta (DNI) o Sin Comprobante.

B2B Recurrente: Puede ser con chofer o sin chofer (máquina seca). No preguntar esto salvo que el cliente lo mencione.

🚨 Reglas de Conversación (Prioridad Máxima)
Un solo dato por mensaje: Realiza una sola pregunta por turno. Nunca combines una confirmación o frase de transición con la siguiente pregunta.

🚫 PROHIBIDO TÍTULOS DE TRATO (No Sra. / Srta. / Sr.): Está estrictamente prohibido anteponer palabras como "Sra.", "Señora", "Srta.", "Señorita", "Sr." o "Señor" antes del nombre del cliente. Diríjase a la persona únicamente por su nombre tal como lo proporcionó (Ej: "Perfecto, Carmen. Ahora por favor...").

No repetir ni resumir datos en el proceso: No parafrasees, confirmes ni resumas lo que el cliente acaba de decir en cada paso. Avanza directamente. El resumen se hace únicamente al final.

Prohibido validar antes del final: No uses frases como "¿Es correcto?" o "¿Me confirma?" en medio del flujo. Solo se permiten en el bloque de resumen final.

Sin preámbulos largos: Avanza al siguiente dato de forma directa. Máximo una frase de transición corta (Ej: "Perfecto, [Nombre]. Ahora...").

No sobreexplicar: No expliques la diferencia entre unidad "básica" vs "full equipo" a menos que el cliente lo solicite explícitamente.

Lectura del primer mensaje (Carga de datos): Si el cliente proporciona datos en su primer mensaje (pax, tipo de unidad, ruta, fecha), regístralos inmediatamente y no los vuelvas a pedir. Pasa directamente al siguiente dato faltante.

Conflicto de datos: Si el cliente da un dato al inicio y luego lo contradice o cambia, no lo sobrescribas automáticamente. Alerta: "Mencionó [valor original] al inicio. ¿Desea cambiarlo a [valor nuevo]?" Actualiza solo tras su confirmación.

Modificaciones previas al resumen: Si el cliente corrige un dato espontáneamente durante el flujo, responde: "Perfecto, ya actualicé ese dato" y continúa con el flujo en el que estabas.

Nombre Completo en Resumen: Solicita el nombre al inicio de cada cotización. Usa el nombre completo (nombres y apellidos) tal como lo brindó en el resumen final, pero jamás le agregues un "Sra." o "Sr." antes.

📍 Regla Obligatoria de Direcciones (Aplica a todos los flujos)
⚠️ REGLA CRÍTICA: Nunca registres como origen o destino únicamente una ciudad, distrito o zona general. Es obligatorio solicitar la dirección exacta con referencia. No avances al siguiente paso hasta obtener ambas direcciones completas.

Pregunta de Origen: "¿Desde qué dirección exacta saldrán? Por favor, indíqueme la calle o avenida, número y una referencia cercana."

Pregunta de Destino: "¿A qué dirección exacta se dirigen? Por favor, indíqueme la calle o avenida, número y una referencia cercana."

🕒 Horarios y Mensajes de Cierre
Horario de atención: Lunes a sábado de 9:00 AM a 5:00 PM (No se atienden feriados).

Cierres automatizados según la hora de recepción del mensaje:

Tramo 1 (9:00 AM – 4:45 PM): "Un asesor se comunicará con usted a la brevedad."

Tramo 2 (4:45 PM – 5:00 PM): "Un asesor se comunicará hoy o a primera hora del siguiente día hábil."

Tramo 3 (Fuera de horario, domingos y feriados): "Le responderemos el siguiente día hábil (lunes a sábado, 9:00 AM – 5:00 PM, sin feriados)."

🛠️ Casos Especiales y Desvíos de Flujo
Saludo simple: Si el cliente solo dice "Hola", muestra el Menú Inicial.

Necesidad directa: Si detalla lo que busca en el primer mensaje, identifica su intención y enrútalo directamente al flujo correspondiente sin mostrar el menú.

Precio directo sin datos: "El precio varía según la ruta, unidad, pasajeros y fecha. ¿Me indica los detalles para poder cotizarle?"

Disponibilidad: "La disponibilidad se confirma con nuestro equipo de operaciones. Registro su solicitud y un asesor le confirmará."

Temas ajenos (Hoteles, vuelos, etc.): "Solo atendemos servicios de transporte terrestre. ¿Le gustaría cotizar un servicio de traslado?"

Más de 50 pasajeros: Sugiere de inmediato una combinación de unidades (Ej: dos buses o minibuses) e indica que el asesor confirmará la distribución exacta.

Fecha pasada: "La fecha indicada ya pasó. ¿Puede confirmarme la fecha correcta?"

Urgencias (Servicios para HOY o YA): "Para servicios de último momento y atención inmediata, por favor comuníquese directamente al 📞 966 707 225."

¿Eres un bot?: "Soy AFITA, el asistente virtual de AFA Transportes. Si prefiere hablar directamente con un humano, con gusto le comunico." (Si acepta, deriva y activa silencio).

Molestia / Queja: "Lamentamos los inconvenientes. Le comunico con un asesor de inmediato. Gracias por su paciencia." (Activa silencio de inmediato; no continúes el flujo).

Intervención Humana: Si un asesor humano interviene en el chat, activa el silencio absoluto por 8 horas. No envíes recordatorios ni cierres.

Recepción de Archivos: "Hemos recibido el archivo. Un asesor lo revisará en nuestro horario de atención." Si el archivo parece un TDR o Bases de licitación, añade: "También puede enviarlo directamente a 📩 transporte@afatoursperu.com".

Licitaciones / TDR / Bases (Texto): "Puede enviarnos toda la documentación de la convocatoria al correo electrónico: 📩 transporte@afatoursperu.com".

Factura sin RUC a la mano: "No hay problema, puede enviarlo luego por este medio." Registra internamente el campo como "RUC pendiente".

Cambio de segmento (B2C ⇄ B2B): Si el cliente cambia de modalidad a mitad del flujo, conserva todos los datos útiles ya recolectados y pregunta únicamente los faltantes del nuevo flujo.

Viabilidad técnica: Si la solicitud no se puede atender (no hay cobertura, no hay unidades de ese tipo, falta de homologación requerida), explica de forma cortés la limitación y cierra el chat. No ofrezcas cotización ni seguimiento.

⏱️ Mensajes de Recuperación (Seguimiento)
Antes de mostrar el resumen: Si el cliente deja de responder, envía un recordatorio a los 30 minutos. Envía un segundo y último recordatorio a los 60 minutos.

Después de mostrar el resumen: Si no confirma el resumen, pregunta: "¿Pudo revisar el resumen? ¿Todo está correcto?" a los 30 minutos. Envía el último mensaje de cierre a los 60 minutos.

Nota: No aplicar flujos de recuperación si intervino un humano, si es un caso de urgencia o si hay una queja de por medio.

🗺️ Estructura de Menú y Flujos Guía
📋 Menú Inicial
Hola 👋 Soy AFITA, asistente virtual de AFA Transportes
Estoy aquí para brindarte atención y orientación según tu necesidad.

1️⃣ Cotizar un servicio
2️⃣ Consultar sobre una reserva
3️⃣ Hacer una consulta general

🏢 Flujo: B2B Recurrente
(Para servicios diarios, mensuales, anuales, contratos, convenios o transporte de personal)

Nombre de la empresa y Nombre del encargado.

Dirección exacta de Origen y Dirección exacta de Destino (con referencias).

Número de pasajeros.

Tipo de movilidad (básica o full equipo).

Frecuencia del servicio (días de la semana) y Horarios (salida y retorno).

Número de RUC.

Informar: Puede enviar documentación o anexos a transporte@afatoursperu.com.

Mostrar Resumen B2B Recurrente y validar.

🏢 Flujo: B2B Eventual
Nombre de la empresa y Nombre del encargado.

Dirección exacta de Origen y Dirección exacta de Destino (con referencias).

Número de pasajeros.

Fecha y hora de salida. (Si el servicio es de más de 1 día, solicitar también fecha y hora de retorno).

Tipo de movilidad.

Tipo de comprobante (¿Requieren factura? Si la respuesta es sí, solicitar RUC).

Mostrar Resumen B2B Eventual y validar.

👤 Flujo: B2C Servicio Particular
(Estricto orden paso a paso. No agrupar, no adelantar preguntas)

Nombre completo (Nombres y Apellidos).

Dirección exacta de Origen (Calle/Av, número y referencia).

Dirección exacta de Destino (Calle/Av, número y referencia).

Cantidad de personas (pasajeros).

Fecha y hora de salida. (Preguntar si aplica retorno y sus datos).

Tipo de movilidad (básica o full equipo).

Tipo de servicio (Solo ida / Ida y vuelta / Por horas).

Tipo de comprobante: Boleta (solicitar DNI), Factura (solicitar RUC) o Sin Comprobante.

Mostrar Resumen B2C y validar.

🕊️ Flujo: Casos Sensibles (Fallecimientos / Velorios / Cementerios)
Respuesta empática inicial: "Lo acompañamos en este momento. Podemos coordinar el servicio con total prioridad. ¿Con quién tengo el gusto?"

Nombre de contacto (sin anteponer Sr./Sra.).

Dirección exacta de Origen y Destino (con referencias).

Cantidad de personas.

Fecha y hora del servicio.

Tipo de movilidad.

Mostrar Resumen Casos Sensibles, validar y cerrar con: "Hemos registrado su solicitud, [Nombre]. Un asesor se comunicará a la brevedad." (Añadir mensaje de horario si corresponde).

📅 Flujo: Consultar Sobre una Reserva
Nombre del titular o Empresa.

Fecha programada del servicio.

Número de teléfono de contacto.

Detalle de la consulta.

Cerrar aplicando mensaje de horario correspondiente.

❓ Flujo: Consulta General
Unidades: Informar la flota disponible. Si pide diferencias entre básica/full equipo, usar los datos de contexto.

Cobertura: "Atendemos a nivel nacional. ¿Me indica cuál es su ruta o destino de interés?"

Seguridad: Informar: "Todas nuestras unidades cuentan con GPS, SOAT, revisión técnica vigente, tarjeta de propiedad, extintor y botiquín de primeros auxilios."

Otra consulta: Atender de forma personalizada según el requerimiento.

Cierre del flujo: "¿Le gustaría cotizar un servicio o tiene alguna otra consulta?"

🧾 Plantilla de Resumen Final (Todos los flujos)
Cuando se tengan todos los datos, genera el resumen utilizando la siguiente estructura visual (recordando no añadir jamás Sr. o Sra. en el nombre):

Plaintext
📋 RESUMEN DE SOLICITUD
──────────────────────────
[Insertar los campos correspondientes del flujo rellenados]
──────────────────────────
¿Todo está correcto, [Nombre Completo del Cliente]?
Si el cliente confirma: Aplica el mensaje de cierre según el Horario actual de recepción del mensaje.

Si el cliente corrige un dato: Actualiza el campo modificado, confirma el cambio y muestra nuevamente el resumen completo actualizado.

Si la respuesta es ambigua: "¿Cuál de los datos de la lista desea modificar?"`;

/** La regla que el dueño va a pegar en «Sobre la empresa» (20-10-2026), literal. */
const AFA_REGLA_NUEVA = `📋 REGLA PRIORITARIA: RECOPILACIÓN DE DATOS EN UN SOLO MENSAJE

🎯 Objetivo

AFITA debe recopilar la mayor cantidad posible de información en un solo mensaje para reducir el abandono de clientes y agilizar las cotizaciones de AFA Transportes.

Regla obligatoria: Cuando un cliente solicite una cotización y no haya proporcionado todos los datos necesarios, AFITA debe solicitar conjuntamente todos los datos pendientes en un único mensaje, en lugar de realizar una pregunta por turno.

No dividas el cuestionario en varias preguntas si los datos pueden solicitarse juntos de manera clara y ordenada.

1. 🚐 Solicitud de cotización: mensaje inicial

Cuando el cliente solicite una cotización y todavía falten datos, utiliza este formato, adaptándolo al tipo de servicio y excluyendo los campos que ya haya proporcionado:

«¡Con gusto le ayudamos! 😊 Para preparar su cotización, por favor, compártanos los siguientes datos:

📅 Fecha del servicio:

🕐 Hora de recojo y hora de retorno:

📍 Dirección de origen: calle o avenida, número y referencia, o ubicación de Google Maps.

📍 Destino o destinos: dirección exacta, referencia o ubicación de Google Maps.

👥 Cantidad de pasajeros:

🚌 Tipo de servicio: traslado, disposición por horas, paseo turístico, servicio empresarial u otro.

📆 Fecha y hora de retorno: si corresponde.

🚐 Tipo de movilidad: auto, SUV, van, minibús o bus, si ya tiene una preferencia.

👤 Nombre completo de la persona que solicita el servicio:

Puede enviarnos todos los datos en un solo mensaje. Si todavía no cuenta con alguna información, indíquenos los datos que tenga disponibles y le ayudaremos a completar lo pendiente».

2. 🧠 Reglas de aplicación obligatoria

* Solicita los datos en un solo mensaje siempre que sea posible.
* No hagas una pregunta por turno como procedimiento predeterminado.
* Antes de enviar el cuestionario, revisa todo el historial de la conversación.
* Elimina del cuestionario los campos que el cliente ya haya respondido claramente.
* Si el cliente proporciona la fecha, ruta, pasajeros y horarios en su primer mensaje, no vuelvas a solicitarlos.
* Para un traslado sencillo, no pidas datos de retorno si el cliente indicó que necesita únicamente ida.
* Si el cliente solicita ida y vuelta, pide los datos de ambos trayectos.
* Si el cliente solicita un servicio por horas, solicita la duración o el horario de disposición.
* Si existen varios destinos, solicita las ubicaciones correspondientes.
* Si el cliente no conoce todavía un dato, registra el campo como pendiente y continúa con los demás.
* No solicites RUC o DNI en el primer cuestionario general, salvo que resulte necesario por el contexto. Recopila los datos de facturación en el momento adecuado.
* No confundas la hora de recojo con la hora de retorno. Cada una debe quedar identificada correctamente.

3. 🏢 Adaptación para empresas

Si la solicitud corresponde a una empresa, utiliza el mismo principio de recopilación conjunta, adaptando el mensaje:

🏢 Nombre de la empresa:

👤 Nombre completo del contacto:

📍 Dirección de origen:

📍 Dirección de destino:

👥 Cantidad de pasajeros:

📅 Fecha de inicio del servicio:

🕐 Horarios de salida y retorno:

🔁 Frecuencia: días de la semana, diario, semanal, mensual u otra.

🚌 Tipo de movilidad: básica o full equipo, si corresponde.

🧾 RUC: si está disponible.

Para servicios recurrentes, solicita conjuntamente todos los campos aplicables. No preguntes por fechas de retorno de un servicio permanente como si se tratara de un traslado turístico de un solo día.

Informa que la documentación de requerimientos, anexos o términos de referencia puede enviarse a transporte@afatoursperu.com.

4. 🔄 Si el cliente responde solo una parte

No vuelvas a enviar el cuestionario completo.

Conserva todos los datos recibidos y solicita únicamente los campos que todavía falten.

Ejemplo:

Si el cliente proporciona fecha, origen, destino y cantidad de pasajeros, pero no indica el horario ni su nombre, pregunta solamente por esos dos datos en un mismo mensaje.

No repitas la información que ya proporcionó ni le hagas validar los datos antes del resumen final.

5. 📍 Precisión de direcciones

Las direcciones deben permitir identificar el punto real del servicio.

* No registres únicamente «Chosica», «Lima», «Miraflores» u otra zona general como dirección exacta.
* Solicita calle o avenida, número y referencia, o acepta una ubicación de Google Maps que permita identificar el punto.
* Si el cliente proporciona el nombre de un establecimiento claramente identificable, solicita información adicional solo si sigue existiendo ambigüedad.
* Si todavía no conoce la dirección exacta, registra el dato como pendiente y continúa con la solicitud.
* Para una cotización definitiva, identifica las direcciones pendientes que puedan afectar la tarifa.

6. 📋 Resumen final

Una vez recopilados los datos necesarios, presenta el resumen de la solicitud con campos visuales y emojis.

No presentes el resumen final hasta que se haya recopilado la información necesaria para el tipo de servicio o se hayan identificado expresamente los datos pendientes.

Solicita la validación una sola vez al final.

Si el cliente modifica algún dato, actualiza únicamente ese campo y presenta nuevamente el resumen completo.

La confirmación del resumen no constituye por sí sola una reserva ni garantiza la disponibilidad del vehículo.

7. 🚨 Prioridad de esta regla

Esta regla prevalece sobre cualquier instrucción anterior que obligue a AFITA a formular una sola pregunta por mensaje.

Principio operativo: primero solicita conjuntamente los datos necesarios; después pregunta solo por lo que falte. Nunca hagas que el cliente repita información que ya proporcionó.`;

const AFA_CONOCIMIENTO = "Horario de atención comercial: Lun-Sáb 8:00-20:00. Para servicios fijos de personal se cotiza por día y mes. Los precios mostrados no incluyen IGV salvo que se indique.";

const AFA_GOALS = [
  { titulo: "Atender y calificar leads", instrucciones: "Saluda, identifica qué servicio necesita el cliente (personal/turismo/eventual), de dónde a dónde, fecha, cantidad de pasajeros y si es ida o ida-retorno. Registra estos datos." },
  { titulo: "Dar cotización estimada", instrucciones: "Cuando tengas origen, destino y tipo de vehículo, usa la herramienta de cotización para dar un rango referencial. Aclara siempre que es estimado y que el equipo confirmará el precio final." },
  { titulo: "Escalar cuando corresponda", instrucciones: "Si el cliente pide hablar con una persona, está molesto, o el caso es complejo (contrato, reclamo, licitación), escala a un humano." },
];

/** El jsonb `comportamiento` real (guardado antes de existir los ajustes nuevos). */
const AFA_COMPORTAMIENTO = {
  hora_noche: 19, hora_tarde: 12, max_audios: 3, ocultar_ia: true, max_archivos: 4, reglas_extra: "",
  saludo_noche: "Buenas noches", saludo_tarde: "Buenas tardes", silencio_seg: 12,
  campos_pedido: "ruta (origen → destino, con la dirección de recojo), fecha y hora, número de pasajeros, equipaje, tipo de servicio (solo ida, ida y vuelta, por horas), nombre y empresa",
  leer_archivos: true, saludo_activo: true, saludo_manana: "Buenos días", espera_max_seg: 45, recordar_datos: true,
  resumen_pedido: true, presentarse_como: "el asistente de {empresa}",
  lugares_conocidos: "el aeropuerto, los terminales terrestres, las estaciones, las plazas y los centros comerciales conocidos",
  mensajes_historial: 40, transcribir_audios: true, etiqueta_derivacion: "Para ejecutivo", intentos_pedir_datos: 1,
  no_decir_no_encontre: true, silencio_completo_seg: 4, nota_interna_derivacion: true,
};

const AFA: ConfigAuditable = {
  nombre: "Afita", persona: AFA_PERSONA, empresa_contexto: AFA_EMPRESA, conocimiento: AFA_CONOCIMIENTO, goals: AFA_GOALS,
  escalar_si: null, mensaje_derivacion: null, pausa_humano_horas: 8, comportamiento: AFA_COMPORTAMIENTO,
};
const CTX_AFA = { trasladosActivos: true, empresa: "AFA TRANSPORTES" };

const rAfa = auditarAgente(AFA, CTX_AFA);
const ESPERADO_AFA_AMBAR = [
  "preguntas.contradice@empresa_contexto", "preguntas.contradice@empresa_contexto",
  "resumen.plantilla_propia@empresa_contexto",
  "horario.textos_chocan@empresa_contexto",
  "seguimiento.imposible@empresa_contexto",
  "archivos.contradice@empresa_contexto",
  "saludo.propio@empresa_contexto",
  "presentacion.distinta@persona", "presentacion.distinta@empresa_contexto",
  "identidad_ia.contradice@persona", "identidad_ia.contradice@empresa_contexto",
  "direccion.contradice@empresa_contexto",
  "traslados.hoy@empresa_contexto",
].sort();
const ESPERADO_AFA_GRIS = [
  "resumen.duplica@empresa_contexto",
  "tratamiento.duplica@empresa_contexto",
  "horario.sin_ajuste@empresa_contexto",
  "horario.cierres_por_hora@empresa_contexto",
  "pausa_humano.duplica@empresa_contexto",
  "derivacion.duplica@empresa_contexto", "derivacion.duplica@goals#3",
  "traslados.varias_unidades@empresa_contexto",
].sort();
const ambarAfa = firma(rAfa.hallazgos.filter((h) => h.alarma));
const grisAfa = firma(rAfa.hallazgos.filter((h) => !h.alarma));
ok(igual(ambarAfa, ESPERADO_AFA_AMBAR), `AFA: ámbar exacto (${ambarAfa.length})${igual(ambarAfa, ESPERADO_AFA_AMBAR) ? "" : `\n   dio: ${ambarAfa.join(", ")}`}`);
ok(igual(grisAfa, ESPERADO_AFA_GRIS), `AFA: gris exacto (${grisAfa.length})${igual(grisAfa, ESPERADO_AFA_GRIS) ? "" : `\n   dio: ${grisAfa.join(", ")}`}`);
ok(rAfa.alarmas === 13 && rAfa.grises === 8, "AFA: 13 alarmas y 8 grises (los contadores cuadran con la lista)");

// Las citas concretas (la frase que el dueño tiene que encontrar).
const citaDe = (hs: Hallazgo[], codigo: CodigoCoherencia, campo?: string) =>
  hs.filter((h) => h.codigo === codigo && (campo == null || h.campo === campo)).map((h) => h.cita);
ok(igual(citaDe(rAfa.hallazgos, "preguntas.contradice"), ["Un solo dato por mensaje: Realiza una sola pregunta por turno.", "(Estricto orden paso a paso. No agrupar, no adelantar preguntas)"]), "AFA: las dos frases de «una pregunta por turno», tal cual");
ok(igual(citaDe(rAfa.hallazgos, "resumen.plantilla_propia"), ["📋 RESUMEN DE SOLICITUD"]), "AFA: la plantilla de resumen se cita por su título");
ok(igual(citaDe(rAfa.hallazgos, "resumen.duplica"), ["El resumen se hace únicamente al final."]), "AFA: «únicamente al final» repite el ajuste (al final)");
ok(igual(citaDe(rAfa.hallazgos, "tratamiento.duplica")[0]?.startsWith("Tratamiento: Siempre de usted"), true), "AFA: «Siempre de usted» repite el ajuste (usted)");
ok(igual(citaDe(rAfa.hallazgos, "seguimiento.imposible"), ["Antes de mostrar el resumen: Si el cliente deja de responder, envía un recordatorio a los 30 minutos."]), "AFA: un solo aviso de recordatorios, citando el primero");
ok(/hay 4 frases así/.test(rAfa.hallazgos.find((h) => h.codigo === "seguimiento.imposible")!.arreglo), "AFA: el arreglo dice cuántas frases de recordatorios hay (4)");
ok(igual(citaDe(rAfa.hallazgos, "archivos.contradice"), ['Recepción de Archivos: "Hemos recibido el archivo. Un asesor lo revisará en nuestro horario de atención."']), "AFA: «Hemos recibido el archivo. Un asesor lo revisará» (una frase con su cita entera)");
ok(igual(citaDe(rAfa.hallazgos, "direccion.contradice"), ["Es obligatorio solicitar la dirección exacta con referencia."]), "AFA: la regla crítica de la dirección exacta");
ok(igual(citaDe(rAfa.hallazgos, "saludo.propio"), ['Saludo simple: Si el cliente solo dice "Hola", muestra el Menú Inicial.']), "AFA: el menú inicial propio");
ok(igual(citaDe(rAfa.hallazgos, "identidad_ia.contradice"), ["Eres AFITA, la asistente virtual de AFA TRANSPORTES , empresa especializada en transporte de personal, turismo y servicios especiales.", "Hola 👋 Soy AFITA, asistente virtual de AFA Transportes"]), "AFA: la persona y el menú dicen «asistente virtual» con «No decir que es una IA» marcado");
ok(igual(citaDe(rAfa.hallazgos, "presentacion.distinta", "empresa_contexto"), ['¿Eres un bot?: "Soy AFITA, el asistente virtual de AFA Transportes. Si prefiere hablar directamente con un humano, con gusto le comunico." (Si acepta, deriva y activa silencio).']), "AFA: «Soy AFITA» se avisa una vez por campo (la primera vez que aparece)");
{
  const tc = rAfa.hallazgos.find((h) => h.codigo === "horario.textos_chocan")!;
  ok(tc.cita === "Horario de atención: Lunes a sábado de 9:00 AM a 5:00 PM (No se atienden feriados)." && tc.otra?.campo === "conocimiento" && tc.otra.cita === "Horario de atención comercial: Lun-Sáb 8:00-20:00.", "AFA: 9-17 («Sobre la empresa») contra 8-20 (Base de conocimiento)");
  ok(/de lunes a sábado, de 09:00 a 17:00/.test(tc.arreglo) && /de 08:00 a 20:00/.test(tc.arreglo), "AFA: el arreglo nombra los dos horarios");
}
ok(igual(citaDe(rAfa.hallazgos, "traslados.hoy")[0]?.startsWith("Urgencias (Servicios para HOY o YA)"), true), "AFA: las urgencias para hoy, con los traslados encendidos");
ok(igual(citaDe(rAfa.hallazgos, "pausa_humano.duplica"), ["Intervención Humana: Si un asesor humano interviene en el chat, activa el silencio absoluto por 8 horas."]), "AFA: 8 h en el texto = 8 h en el ajuste → repite");
ok(rAfa.hallazgos.find((h) => h.codigo === "derivacion.duplica" && h.campo === "goals")?.etiquetaCampo === "Objetivo 3: Escalar cuando corresponda", "AFA: el objetivo se nombra con su número y su título");
ok(rAfa.hallazgos.slice(0, rAfa.alarmas).every((h) => h.alarma) && rAfa.hallazgos.slice(rAfa.alarmas).every((h) => !h.alarma), "AFA: alarmas primero");

// Lo que NO debe salir (las trampas conocidas).
const citas = rAfa.hallazgos.map((h) => `${h.cita} ${h.otra?.cita ?? ""}`);
const ninguna = (re: RegExp, m: string) => ok(!citas.some((c) => re.test(c)), `AFA no avisa: ${m}`);
ninguna(/B2B|B2C/, "«eres formal / eres cercana» (B2B / B2C)");
ninguna(/IGV/, "los precios sin IGV");
ninguna(/No eres un bot frío/, "«No eres un bot frío»");
ok(!rAfa.hallazgos.some((h) => h.tema === "horario" && /30 minutos|60 minutos|8 horas/.test(h.cita)), "AFA no lee un horario en «30 minutos», «60 minutos» u «8 horas»");
ok(!rAfa.hallazgos.some((h) => h.codigo === "seguimiento.imposible" && /silencio/.test(h.cita)), "AFA: el silencio de 8 h no es un seguimiento");
ok(!rAfa.hallazgos.some((h) => h.codigo === "seguimiento.imposible" && /No envíes recordatorios/.test(h.cita)), "AFA: «No envíes recordatorios» no es un seguimiento");
ok(!rAfa.hallazgos.some((h) => h.tema === "pausa_humano" && /Activa silencio/.test(h.cita) && !/8 horas/.test(h.cita)), "AFA: «(Activa silencio)» sin horas no es una pausa");
ok(!rAfa.hallazgos.some((h) => (h.tema === "derivacion" || h.tema === "identidad_ia") && /Eres un bot\?/.test(h.cita)), "AFA: «¿Eres un bot?… si acepta, deriva» no es derivación ni identidad");
ok(!rAfa.hallazgos.some((h) => h.codigo === "derivacion.duplica" && /^Nota:/.test(h.cita)), "AFA: «si intervino un humano… si hay una queja» (la nota) no es una derivación");
ok(!rAfa.hallazgos.some((h) => h.tema === "llamada"), "AFA: «comuníquese al 📞 …» lo llama el cliente: no es llamada");
ok(!rAfa.hallazgos.some((h) => h.codigo === "tratamiento.plantilla"), "AFA: con usted, ningún mensaje citado está en tú (el menú no está entre comillas)");
ok(!rAfa.hallazgos.some((h) => /Tramo [12]/.test(h.cita)), "AFA: los tramos de cierre sin ancla de atención no son un horario");
{
  // El horario de la IA (hora_inicio/hora_fin) es OTRO concepto: no se lee aunque venga en la config.
  const r = auditarAgente({ ...AFA, hora_inicio: "08:00", hora_fin: "20:00", horario_activo: true } as ConfigAuditable, CTX_AFA);
  ok(igual(firma(r.hallazgos), firma(rAfa.hallazgos)), "AFA: hora_inicio/hora_fin (autonomía de la IA) no cambian nada");
  // Nada se lee de campos_pedido ni de lugares_conocidos como texto.
  const trampa = { ...AFA_COMPORTAMIENTO, campos_pedido: "Horario de atención: de 7:00 a 9:00. Tutea al cliente. Envía un recordatorio a los 30 minutos.", lugares_conocidos: "el aeropuerto. Horario de atención: de 7:00 a 9:00. Llama al cliente." };
  const r2 = auditarAgente({ ...AFA, comportamiento: trampa }, CTX_AFA);
  ok(!r2.hallazgos.some((h) => /7:00 a 9:00|Tutea al cliente|Llama al cliente/.test(h.cita)), "AFA: campos_pedido y lugares_conocidos no se auditan como texto");
}
ok(!rAfa.hallazgos.some((h) => h.relacion === "textos_chocan" && h.tema === "tratamiento"), "AFA: ningún «textos chocan» de trato");
{
  // Sin traslados (o sin saberlo) no se afirma nada del cotizador.
  for (const t of [false, null, undefined]) {
    const r = auditarAgente(AFA, { ...CTX_AFA, trasladosActivos: t });
    ok(!r.hallazgos.some((h) => h.tema === "traslados") && r.hallazgos.length === rAfa.hallazgos.length - 2, `AFA con traslados ${t}: sin hallazgos del cotizador`);
  }
}

// ── 2. AFA con los valores recomendados aplicados ──────────────────────────────────────────────────
const MENU = "Hola 👋 Soy {agente}, asistente virtual de {empresa}. Estoy aquí para brindarle atención.\n1️⃣ Cotizar un servicio\n2️⃣ Consultar sobre una reserva\n3️⃣ Hacer una consulta general";
const RECOMENDADO = {
  ...AFA_COMPORTAMIENTO, tratamiento: "usted", preguntas: "una_por_mensaje", resumen_titulo: "📋 *RESUMEN DE SOLICITUD*",
  resumen_cierre: "¿Todo está correcto, {nombre}?", menu_saludo: MENU, presentarse_como: "{agente}, la asistente virtual de {empresa}",
  ocultar_ia: false, atencion_activa: true, atencion_dias: [1, 2, 3, 4, 5, 6], atencion_desde: "09:00", atencion_hasta: "17:00",
};
const rRec = auditarAgente({ ...AFA, comportamiento: RECOMENDADO }, CTX_AFA);
ok(igual(firma(rRec.hallazgos.filter((h) => h.alarma)), [
  "archivos.contradice@empresa_contexto", "direccion.contradice@empresa_contexto", "horario.contradice@conocimiento",
  "seguimiento.imposible@empresa_contexto", "traslados.hoy@empresa_contexto",
].sort()), `recomendado: solo quedan en ámbar los que exigen editar el texto${rRec.alarmas === 5 ? "" : `\n   dio: ${firma(rRec.hallazgos.filter((h) => h.alarma)).join(", ")}`}`);
ok(igual(firma(rRec.hallazgos.filter((h) => !h.alarma)), [
  "preguntas.duplica@empresa_contexto", "preguntas.duplica@empresa_contexto", "resumen.duplica@empresa_contexto", "resumen.duplica@empresa_contexto",
  "tratamiento.duplica@empresa_contexto", "saludo.duplica@empresa_contexto", "presentacion.duplica@persona", "presentacion.duplica@empresa_contexto",
  "horario.duplica@empresa_contexto", "horario.cierres_por_hora@empresa_contexto", "pausa_humano.duplica@empresa_contexto",
  "derivacion.duplica@empresa_contexto", "derivacion.duplica@goals#3", "traslados.varias_unidades@empresa_contexto",
].sort()), `recomendado: el resto pasa a gris${rRec.grises === 14 ? "" : `\n   dio: ${firma(rRec.hallazgos.filter((h) => !h.alarma)).join(", ")}`}`);
{
  const hc = rRec.hallazgos.find((h) => h.codigo === "horario.contradice")!;
  ok(hc.cita === "Horario de atención comercial: Lun-Sáb 8:00-20:00." && hc.ajuste?.valorLegible === "de lunes a sábado, de 09:00 a 17:00", "recomendado: la base de conocimiento (8-20) contradice el horario declarado (9-17)");
  ok(rRec.hallazgos.filter((h) => h.codigo === "horario.duplica").length === 1, "recomendado: las dos frases de 9-17 en «Sobre la empresa» son UN aviso (mismo campo, mismo horario)");
  ok(!rRec.hallazgos.some((h) => h.codigo === "horario.textos_chocan" || h.codigo === "horario.sin_ajuste"), "recomendado: con el horario declarado no hay texto contra texto");
  // nuevasAlarmas: lo único «nuevo» al aplicar lo recomendado es el horario de la base de
  // conocimiento, que antes era la otra mitad del «dos textos chocan» y ahora choca con el ajuste.
  ok(igual(firma(nuevasAlarmas(rAfa.hallazgos, rRec.hallazgos)), ["horario.contradice@conocimiento"]), "recomendado: la única alarma «nueva» es el 8-20 de la base de conocimiento contra el ajuste");
}

// ── 3. Barrido de polaridad ─────────────────────────────────────────────────────────────────────────
type Polo = { tema: string; valores: { ajuste: Record<string, unknown>; dice: string | null; cfg?: Partial<ConfigAuditable> }[]; textos: { dice: string; frase: string }[] };
const POLOS: Polo[] = [
  {
    tema: "tratamiento",
    valores: [{ ajuste: { tratamiento: "usted" }, dice: "usted" }, { ajuste: { tratamiento: "tu" }, dice: "tu" }],
    textos: [{ dice: "usted", frase: "Trátalo siempre de usted." }, { dice: "tu", frase: "Tutea al cliente." }, { dice: "tu", frase: "Háblale de tú." }, { dice: "usted", frase: "No tutees a nadie." }],
  },
  {
    tema: "preguntas",
    valores: [{ ajuste: { preguntas: "todo_junto" }, dice: "junto" }, { ajuste: { preguntas: "una_por_mensaje" }, dice: "una" }],
    textos: [{ dice: "una", frase: "Haz una sola pregunta por mensaje." }, { dice: "junto", frase: "Pide todos los datos que faltan juntos, en un solo mensaje." }, { dice: "una", frase: "Pide los datos de uno en uno." }],
  },
  {
    tema: "resumen",
    valores: [
      { ajuste: { resumen_pedido: true, resumen_cuando: "al_final" }, dice: "final" },
      { ajuste: { resumen_pedido: true, resumen_cuando: "cada_respuesta" }, dice: "cada" },
      { ajuste: { resumen_pedido: false }, dice: null },
    ],
    textos: [{ dice: "final", frase: "Muestra el resumen solo al final." }, { dice: "cada", frase: "Muestra el resumen al final de cada respuesta." }, { dice: "final", frase: "No muestres el resumen en cada mensaje." }],
  },
  {
    tema: "archivos",
    valores: [{ ajuste: { leer_archivos: true }, dice: "lee" }, { ajuste: { leer_archivos: false }, dice: "no" }],
    textos: [{ dice: "no", frase: "Si el cliente manda un archivo, dile que un asesor lo revisará." }, { dice: "lee", frase: "Lee las fotos y los PDF que mande el cliente." }],
  },
  {
    tema: "audios",
    valores: [{ ajuste: { transcribir_audios: true }, dice: "escucha" }, { ajuste: { transcribir_audios: false }, dice: "no" }],
    textos: [{ dice: "no", frase: "Si mandan un audio, pide que lo escriba." }, { dice: "escucha", frase: "Escucha las notas de voz y respóndelas." }],
  },
  {
    tema: "identidad_ia",
    // Desmarcado, el ajuste no opina (no entra al bloque de ajustes): manda el texto.
    valores: [{ ajuste: { ocultar_ia: true }, dice: "oculta" }, { ajuste: { ocultar_ia: false }, dice: null }],
    textos: [{ dice: "oculta", frase: "No digas que eres una IA." }, { dice: "revela", frase: "Preséntate como asistente virtual." }],
  },
  {
    tema: "pausa_humano",
    valores: [
      { ajuste: {}, cfg: { pausa_humano_horas: 8 }, dice: "8" },
      { ajuste: {}, cfg: { pausa_humano_horas: 12 }, dice: "12" },
      { ajuste: {}, cfg: { pausa_humano_horas: 0 }, dice: "0" },
      { ajuste: {}, cfg: { pausa_humano_horas: null }, dice: "12" },
    ],
    textos: [{ dice: "8", frase: "Si un asesor interviene en el chat, guarda silencio por 8 horas." }, { dice: "12", frase: "Si una persona del equipo responde, haz una pausa de 12 horas." }],
  },
];
let combinaciones = 0, ciclos = 0;
for (const p of POLOS)
  for (const v of p.valores) {
    const base = { ...v.cfg, comportamiento: { ...v.ajuste } };
    // Sin texto: nada de ese tema.
    const vacio = auditarAgente(base);
    ok(!vacio.hallazgos.some((h) => h.tema === p.tema), `${p.tema} ${JSON.stringify(v.ajuste)}${v.cfg ? JSON.stringify(v.cfg) : ""} sin texto → nada`);
    for (const t of p.textos) {
      combinaciones++;
      const r = auditarAgente({ ...base, empresa_contexto: t.frase });
      const del = r.hallazgos.filter((h) => h.tema === p.tema);
      const cods = del.map((h) => h.codigo.split(".")[1]);
      let esperado: string[];
      if (v.dice == null) esperado = p.tema === "resumen" ? ["sin_ajuste"] : t.dice === "oculta" ? ["sin_ajuste"] : [];
      else esperado = [t.dice === v.dice ? "duplica" : "contradice"];
      ok(igual(cods, esperado), `${p.tema} ajuste=${v.dice ?? "sin opinión"} × texto «${t.frase}» → ${esperado.join(",") || "nada"}${igual(cods, esperado) ? "" : ` (dio ${cods.join(",") || "nada"})`}`);
      // Ciclo cerrado: aplicar la propuesta convierte el choque en una frase que repite.
      const c = del.find((h) => h.codigo.endsWith(".contradice") && h.propuesta);
      if (c?.propuesta) {
        ciclos++;
        const r2 = auditarAgente({ ...base, empresa_contexto: t.frase, comportamiento: { ...v.ajuste, [c.propuesta.clave]: c.propuesta.valor } });
        const d2 = r2.hallazgos.filter((h) => h.tema === p.tema);
        ok(d2.length === 1 && d2[0].codigo.endsWith(".duplica") && d2[0].cita === c.cita, `${p.tema}: poner el ajuste en «${c.propuesta.etiqueta}» convierte el choque en «repite»`);
      }
    }
  }
ok(combinaciones >= 30, `barrido de polaridad: ${combinaciones} combinaciones`);
ok(ciclos >= 6, `corolario: el barrido cierra ${ciclos} ciclos de propuesta`);
// Solo los temas de opciones proponen un valor.
ok(rAfa.hallazgos.every((h) => !h.propuesta || ["tratamiento", "preguntas", "resumen_cuando"].includes(h.propuesta.clave)), "solo trato, preguntas y cuándo-resumen traen propuesta");
ok(rAfa.hallazgos.filter((h) => h.codigo === "preguntas.contradice").every((h) => h.propuesta?.valor === "una_por_mensaje"), "AFA: la propuesta de preguntas es «uno por mensaje»");

// ── 4. Corpus de frases benignas: 0 hallazgos ─────────────────────────────────────────────────────
const CORPUS = [
  "Si es una empresa (B2B), sé formal; si es un particular (B2C), sé cercana.",
  "Sé formal y cordial en todo momento.",
  "Ofrece llevar a la gente de tu empresa al evento.",
  "Tu objetivo es ayudar al cliente a cotizar.",
  "Guía al cliente paso a paso.",
  "No agrupes pasajeros de empresas distintas en la misma unidad.",
  "El resumen de la ruta incluye las paradas.",
  "El bus llega 15 minutos antes de la hora de recojo.",
  "Atendemos traslados las 24 horas.",
  "Recuerda que el precio no incluye IGV.",
  "Si el cliente prefiere, puede llamar al 999 888 777.",
  "Si está molesto, sé empático y escúchalo.",
  "¿Eres un bot? Responde con naturalidad y, si acepta hablar con una persona, deriva.",
  "La dirección de nuestra oficina es Av. Javier Prado 123, San Isidro.",
  "Los precios mostrados no incluyen IGV salvo que se indique.",
  "La flota incluye vans de 10-15 pax y buses de 45-50 pax.",
  "Para servicios fijos de personal se cotiza por día y mes.",
  "Te comunicas de forma natural, clara y profesional.",
  "No eres un bot frío: eres cercana y resolutiva.",
  "Pregunta siempre el número de pasajeros.",
  "Horario de salida: 6:00 a 7:30, según la ruta.",
  "Si el cliente envía la foto de su DNI, regístralo.",
  "Responde en el idioma del cliente.",
  "Cobertura nacional: atendemos a todo el Perú.",
  "Para más de 2 días de servicio, pide la fecha de retorno.",
  "Nunca registres solo el distrito: pregunta por la referencia.",
  "No ofrezcas cotización ni seguimiento si no hay cobertura.",
  "Si un asesor humano interviene, no envíes recordatorios.",
  "Activa silencio si el cliente lo pide.",
  "Nota: No aplicar flujos de recuperación si intervino un humano o si hay una queja de por medio.",
  "Muestra el menú si el cliente pide opciones.",
  "Usa los datos de la base de conocimiento antes de responder.",
  "Si el servicio es para hoy, revisa la disponibilidad en el tarifario.",
  "Puede enviarnos la documentación por correo.",
  // Verosímiles en la instalación de otro comprador (cada una disparaba antes de afinar su familia).
  "Eres el asistente de ventas y usas la IA para cotizar.",
  "Si el cliente envía la foto del equipo para revisar el estado, regístralo.",
  "El conductor atiende el servicio de 6:00 a 14:00.",
  "Atendemos servicios de 5:00 a 23:00 todos los días.",
  "No adelantes datos de precio sin cotizar.",
  "Guarda todos los datos juntos con actualizar_contacto.",
  "Usa el saludo configurado en el sistema.",
  "El conductor llama al cliente al llegar al punto de recojo.",
  'Si el cliente pregunta "¿tienes buses para 50 personas?", responde con la flota.',
  'No uses frases como "¿te ayudo en algo más, amigo?" con empresas.',
  "Eres responsable de que el cliente reciba su cotización.",
  "El sistema envía al pasajero un recordatorio 12 horas antes del servicio.",
  "Dale la bienvenida al cliente con amabilidad.",
  "Si el cliente manda la foto del voucher, dile que la recibiste.",
  "Recuerda pedir el RUC si quiere factura.",
  "La unidad sale a las 6:00 y retorna a las 18:00.",
  "Turno de mañana: de 6:00 a 14:00.",
  "Nunca envíes la cotización sin el número de pasajeros.",
];
{
  let ruido = 0;
  for (const frase of CORPUS)
    for (const campo of ["persona", "empresa_contexto", "conocimiento", "reglas_extra"] as const) {
      const cfg: ConfigAuditable = campo === "reglas_extra"
        ? { nombre: "Ana", comportamiento: { reglas_extra: frase } }
        : { nombre: "Ana", [campo]: frase };
      const r = auditarAgente(cfg, { trasladosActivos: true, empresa: "ACME" });
      if (r.hallazgos.length) { ruido++; console.log(`   ruido en ${campo}: «${frase}» → ${codigos(r.hallazgos).join(", ")}`); }
    }
  ok(CORPUS.length >= 20 && ruido === 0, `corpus de ${CORPUS.length} frases benignas × 4 campos: 0 hallazgos`);
  // Las mismas en un solo texto (frase a frase en líneas) tampoco suman nada.
  const r = auditarAgente({ nombre: "Ana", empresa_contexto: CORPUS.join("\n") }, { trasladosActivos: true, empresa: "ACME" });
  ok(r.hallazgos.length === 0, `el corpus junto: 0 hallazgos${r.hallazgos.length ? ` (dio ${codigos(r.hallazgos).join(", ")})` : ""}`);
}

// ── 5. Positivos sintéticos: un caso por código que el caso AFA no cubre ───────────────────────────
type Caso = { codigo: CodigoCoherencia; cfg: ConfigAuditable; ctx?: { trasladosActivos?: boolean | null; empresa?: string }; campo?: string | null };
const CASOS: Caso[] = [
  { codigo: "tratamiento.contradice", cfg: { persona: "Tutea siempre al cliente." } },
  { codigo: "tratamiento.plantilla", cfg: { empresa_contexto: 'Saludo simple: muestra el Menú Inicial: "Hola 👋 Soy Ana, estoy aquí para brindarte atención"' } },
  { codigo: "tratamiento.plantilla", cfg: { mensaje_derivacion: "Gracias, {nombre}. Ya registré tu pedido; un ejecutivo te escribe en breve." }, campo: "mensaje_derivacion" },
  { codigo: "tratamiento.plantilla", cfg: { empresa_contexto: 'Al final di: "Un asesor se comunicará con usted a la brevedad."', comportamiento: { tratamiento: "tu" } } },
  { codigo: "tratamiento.ajuste_en_otro_trato", cfg: { comportamiento: { menu_saludo: "Hola 👋 Soy Ana. Estoy aquí para brindarte atención y orientación según tu necesidad." } }, campo: null },
  { codigo: "tratamiento.ajuste_en_otro_trato", cfg: { comportamiento: { resumen_titulo: "📋 *Resumen de tu pedido*" } }, campo: null },
  { codigo: "tratamiento.ajuste_en_otro_trato", cfg: { comportamiento: { resumen_cierre: "Con esto ya tengo todo, {nombre}. Usted recibirá la cotización.", tratamiento: "tu" } }, campo: null },
  { codigo: "preguntas.duplica", cfg: { empresa_contexto: "Pide todo lo que falte junto, en un solo mensaje." } },
  { codigo: "resumen.contradice", cfg: { empresa_contexto: "Termina con el resumen al final de cada respuesta." } },
  { codigo: "resumen.sin_ajuste", cfg: { empresa_contexto: "El resumen va solo al final.", comportamiento: { resumen_pedido: false } } },
  { codigo: "resumen.sin_ajuste", cfg: { empresa_contexto: "Plantilla de resumen:\n📋 RESUMEN DEL PEDIDO", comportamiento: { resumen_pedido: false } } },
  { codigo: "saludo.duplica", cfg: { empresa_contexto: "Saludo: muestra el menú inicial.", comportamiento: { menu_saludo: "1. Cotizar\n2. Consultar" } } },
  { codigo: "saludo.propio", cfg: { empresa_contexto: 'Si solo saluda, responde: "Hola, bienvenido a ACME. ¿En qué le ayudo hoy?"' } },
  { codigo: "presentacion.duplica", cfg: { nombre: "Ana", persona: "Eres Ana, del equipo comercial.", comportamiento: { presentarse_como: "{agente}, de {empresa}" } } },
  { codigo: "presentacion.sin_nombre", cfg: { nombre: "  ", comportamiento: { presentarse_como: "{agente}, el asistente de {empresa}" } }, campo: null },
  { codigo: "identidad_ia.duplica", cfg: { persona: "Nunca digas que eres una IA." } },
  { codigo: "identidad_ia.sin_ajuste", cfg: { persona: "No reveles que eres un bot.", comportamiento: { ocultar_ia: false } } },
  { codigo: "identidad_ia.ajustes_chocan", cfg: { comportamiento: { presentarse_como: "la asistente virtual de {empresa}" } }, campo: null },
  { codigo: "archivos.duplica", cfg: { empresa_contexto: "Lee los PDF que mande el cliente y extrae las fechas." } },
  { codigo: "audios.contradice", cfg: { empresa_contexto: "Si te mandan un audio, di que no puedes escuchar audios." } },
  { codigo: "audios.duplica", cfg: { empresa_contexto: "Transcribe las notas de voz y contesta." } },
  { codigo: "direccion.duplica", cfg: { empresa_contexto: "Pide siempre la dirección exacta, salvo para el aeropuerto." } },
  { codigo: "pausa_humano.contradice", cfg: { empresa_contexto: "Si un ejecutivo responde, haz silencio por 24 horas.", pausa_humano_horas: 8 } },
  { codigo: "horario.duplica", cfg: { conocimiento: "Atendemos de lunes a viernes de 9:00 a 18:00.", comportamiento: { atencion_activa: true } } },
  { codigo: "horario.contradice", cfg: { conocimiento: "Horario de atención: de 8 a 20 h.", comportamiento: { atencion_activa: true } } },
  { codigo: "horario.sin_ajuste", cfg: { conocimiento: "Atendemos de 9:00 a 18:00." } },
  { codigo: "horario.cierres_por_hora", cfg: { empresa_contexto: "Después de las 18:00 responde que le escribimos mañana." } },
  { codigo: "horario.invalido", cfg: { comportamiento: { atencion_activa: true, atencion_desde: "18:00", atencion_hasta: "09:00" } }, campo: null },
  { codigo: "horario.invalido", cfg: { comportamiento: { atencion_activa: true, atencion_dias: [] } }, campo: null },
  { codigo: "horario.derivacion_sin_atencion", cfg: { mensaje_derivacion: "Gracias, {nombre}. Un ejecutivo le responde en breve.", comportamiento: { atencion_activa: true } }, campo: "mensaje_derivacion" },
  { codigo: "llamada.imposible", cfg: { empresa_contexto: "Si el cliente no contesta, llámalo por teléfono." } },
  { codigo: "seguimiento.imposible", cfg: { goals: [{ titulo: "Seguimiento", instrucciones: "Si el cliente no responde, escríbele de nuevo a las 2 horas." }] }, campo: "goals" },
];
{
  const cubiertos = new Set<string>(codigos(rAfa.hallazgos));
  for (const k of CASOS) {
    const r = auditarAgente({ nombre: "Ana", ...k.cfg }, k.ctx ?? { empresa: "ACME" });
    const h = r.hallazgos.find((x) => x.codigo === k.codigo);
    const campoOk = k.campo === undefined || (h && h.campo === k.campo);
    ok(!!h && !!campoOk, `positivo ${k.codigo}${k.campo !== undefined ? ` (${k.campo ?? "ajuste"})` : ""}${h ? "" : ` · dio ${codigos(r.hallazgos).join(", ") || "nada"}`}`);
    if (h) cubiertos.add(h.codigo);
  }
  // Los dos de traslados ya los cubre AFA; con trasladosActivos en false no salen (arriba).
  const faltan = (Object.keys(TABLA_HALLAZGOS) as CodigoCoherencia[]).filter((c) => !cubiertos.has(c));
  ok(faltan.length === 0, `todo código de la tabla tiene un caso que lo produce${faltan.length ? ` (faltan: ${faltan.join(", ")})` : ""}`);
}
// Los textos que viven en ajustes (menú, título y cierre del resumen) contra el trato.
{
  const aud = (comp: Record<string, unknown>) => auditarAgente({ comportamiento: comp }).hallazgos;
  const menuTu = "Hola 👋 Soy Ana. Estoy aquí para brindarte atención y orientación según tu necesidad.";
  const h = aud({ menu_saludo: menuTu }).find((x) => x.codigo === "tratamiento.ajuste_en_otro_trato");
  ok(!!h && h.alarma && h.campo === null && h.cita === menuTu && h.ajuste?.clave === "menu_saludo" && h.ajuste.ancla === "ajuste-saludo",
    "menú «…brindarte atención» con usted → ámbar, sin campo, cita = el menú, manda menu_saludo (ancla ajuste-saludo)");
  ok(/menú del saludo está escrito de tú/.test(h?.arreglo ?? "") && /dice de usted/.test(h?.arreglo ?? ""), "el arreglo dice qué texto, en qué trato y qué dice el ajuste");
  const t = aud({ resumen_titulo: "📋 *Resumen de tu pedido*", resumen_cierre: "Listo, te escribo en breve." }).filter((x) => x.codigo === "tratamiento.ajuste_en_otro_trato");
  ok(igual(t.map((x) => x.ajuste?.clave).sort(), ["resumen_cierre", "resumen_titulo"]) && t.every((x) => x.ajuste?.ancla === "ajuste-resumen"), "título y cierre del resumen en tú con usted → dos avisos con ancla ajuste-resumen");
  // Lo benigno no salta.
  const benignos: Record<string, unknown>[] = [
    { menu_saludo: "¿En qué le puedo ayudar?" },
    { menu_saludo: "1️⃣ Cotizar un servicio\n2️⃣ Consultar sobre una reserva" },
    { menu_saludo: "¿En qué te puedo ayudar? 1. Cotizar 2. Reservas", tratamiento: "tu" },
    { resumen_titulo: "📋 *RESUMEN DE SOLICITUD*", resumen_cierre: "¿Todo está correcto, {nombre}?" },
    { resumen_titulo: "📋 *Resumen de tu solicitud*", tratamiento: "tu" },
    { resumen_cierre: "Con esto ya tengo todo lo necesario" },
    { resumen_cierre: "Con esto ya tengo todo lo necesario", tratamiento: "tu" },
  ];
  for (const b of benignos) ok(aud(b).length === 0, `ajustes benignos → nada: ${JSON.stringify(b).slice(0, 70)}`);
  // Solo cuando se usan: con el saludo o el resumen apagados no llegan al cliente.
  ok(aud({ menu_saludo: menuTu, saludo_activo: false }).length === 0, "menú en tú con el saludo apagado → nada (no se usa)");
  ok(aud({ resumen_titulo: "📋 *Resumen de tu pedido*", resumen_pedido: false }).length === 0, "título en tú con el resumen apagado → nada (no se usa)");
  // El menú real de AFA (en tú) puesto en el ajuste con trato de usted sí salta; el recomendado (de usted), no.
  const afaMenu = auditarAgente({ ...AFA, comportamiento: { ...RECOMENDADO, menu_saludo: "Hola 👋 Soy AFITA, asistente virtual de AFA Transportes\nEstoy aquí para brindarte atención y orientación según tu necesidad." } }, CTX_AFA);
  ok(afaMenu.hallazgos.filter((x) => x.codigo === "tratamiento.ajuste_en_otro_trato").length === 1 && afaMenu.alarmas === rRec.alarmas + 1, "AFA: su menú real (brindarte) en el ajuste con usted → una alarma más");
  ok(!rRec.hallazgos.some((x) => x.codigo === "tratamiento.ajuste_en_otro_trato"), "AFA recomendado (menú de usted): nada");
  // «sin_nombre» no cambia: {agente} sin nombre sigue saliendo.
  ok(auditarAgente({ nombre: "", comportamiento: { presentarse_como: "{agente}, de {empresa}" } }).hallazgos.some((x) => x.codigo === "presentacion.sin_nombre"), "presentacion.sin_nombre sigue igual");
}
// Que el cliente tutee no es el trato que se pide: «aunque te tutee, responde de usted» declara usted.
{
  const r = auditarAgente({ empresa_contexto: "Si el cliente tutea, puedes responder con naturalidad pero de usted." });
  ok(igual(codigos(r.hallazgos), ["tratamiento.duplica"]), "«si el cliente tutea… de usted» declara usted (repite el ajuste)");
  const r2 = auditarAgente({ empresa_contexto: "Habla de usted con las empresas y tutea a los jóvenes." });
  ok(r2.hallazgos.length === 0, "un trato por segmento de cliente (las dos cosas) no se afirma");
}
// AFA si eligiera tutear: avisa de cada mensaje citado de usted, nunca de lo que dice el cliente.
{
  const r = auditarAgente({ ...AFA, comportamiento: { ...AFA_COMPORTAMIENTO, tratamiento: "tu" } }, CTX_AFA);
  const pl = r.hallazgos.filter((h) => h.codigo === "tratamiento.plantilla");
  ok(pl.length >= 5 && pl.every((h) => /usted|ndíqueme|comuníquese|cotizarle|\bLe\b|le /.test(h.cita)), `AFA de tú: ${pl.length} mensajes citados de usted`);
  ok(r.hallazgos.some((h) => h.codigo === "tratamiento.contradice" && h.cita.startsWith("Tratamiento: Siempre de usted")), "AFA de tú: «Siempre de usted» contradice, con propuesta");
  ok(!pl.some((h) => /Es correcto|Me confirma/.test(h.cita)), "AFA de tú: las «frases como…» prohibidas no son plantillas");
}
// textos_chocan con tres horarios: un aviso por par.
{
  const r = auditarAgente({ persona: "Atendemos de 9:00 a 18:00.", empresa_contexto: "Horario de atención: de 8:00 a 17:00.", conocimiento: "Atendemos de 10:00 a 19:00." });
  ok(r.hallazgos.filter((h) => h.codigo === "horario.textos_chocan").length === 3, "tres horarios distintos → tres pares");
  ok(new Set(r.hallazgos.map(claveHallazgo)).size === r.hallazgos.length, "tres horarios: claves distintas");
}
// Una plantilla con el resumen del ajuste propio → repite (no es plantilla propia).
{
  const r = auditarAgente({ empresa_contexto: "Usa esta plantilla de resumen:\n📋 Resumen de su solicitud\n• dato: valor" });
  ok(igual(codigos(r.hallazgos), ["resumen.duplica"]), "el título del ajuste (automático) escrito en el texto → repite");
}
// El texto REAL que el dueño va a pegar (20-10-2026): sus negaciones y su frase de prioridad dicen
// «todo junto», y su «6. 📋 Resumen final» es un encabezado, no una plantilla.
{
  const juntas = [
    "* No hagas una pregunta por turno como procedimiento predeterminado.",
    "Regla obligatoria: Cuando un cliente solicite una cotización y no haya proporcionado todos los datos necesarios, AFITA debe solicitar conjuntamente todos los datos pendientes en un único mensaje, en lugar de realizar una pregunta por turno.",
    "No dividas el cuestionario en varias preguntas si los datos pueden solicitarse juntos de manera clara y ordenada.",
    "Esta regla prevalece sobre cualquier instrucción anterior que obligue a AFITA a formular una sola pregunta por mensaje.",
    "Nunca realices una sola pregunta por mensaje.",
    "Pide todo junto, en vez de hacer una pregunta a la vez.",
    "Esta regla deja sin efecto la de una pregunta por turno.",
    "* Solicita los datos en un solo mensaje siempre que sea posible.",
    "Para servicios recurrentes, solicita conjuntamente todos los campos aplicables.",
  ];
  for (const frase of juntas) {
    const a = auditarAgente({ empresa_contexto: frase }).hallazgos.filter((h) => h.tema === "preguntas").map((h) => h.codigo);
    const b = auditarAgente({ empresa_contexto: frase, comportamiento: { preguntas: "una_por_mensaje" } }).hallazgos.filter((h) => h.tema === "preguntas").map((h) => h.codigo);
    ok(igual(a, ["preguntas.duplica"]) && igual(b, ["preguntas.contradice"]), `«${frase.slice(0, 60)}…» dice «todo junto» (todo junto → repite; uno por mensaje → contradice)${igual(a, ["preguntas.duplica"]) && igual(b, ["preguntas.contradice"]) ? "" : ` (dio ${a.join(",")} / ${b.join(",")})`}`);
  }
  // Las afirmativas siguen diciendo «uno por mensaje».
  for (const frase of ["Haz una sola pregunta por turno.", "Un solo dato por mensaje: Realiza una sola pregunta por turno.", "No te demores: haz una pregunta por mensaje."])
    ok(igual(auditarAgente({ empresa_contexto: frase }).hallazgos.map((h) => h.codigo), ["preguntas.contradice"]), `«${frase}» sigue diciendo «uno por mensaje»`);
  // Encabezados de resumen, no plantillas.
  for (const frase of ["6. 📋 Resumen final", "📋 Resumen del pedido", "Resumen B2B Recurrente"])
    ok(auditarAgente({ empresa_contexto: frase }).hallazgos.length === 0, `«${frase}» es un encabezado, no una plantilla`);
  ok(igual(auditarAgente({ empresa_contexto: "📋 RESUMEN DEL PEDIDO\n• Fecha: …" }).hallazgos.map((h) => h.codigo), ["resumen.plantilla_propia"]), "«📋 RESUMEN DEL PEDIDO» en mayúsculas sí es una plantilla propia");
  // El texto entero, como lo pegaría el dueño: sin un solo choque de preguntas ni de resumen, solo o
  // agregado a su «Sobre la empresa» (donde sí chocan las DOS frases viejas de «una pregunta por turno»).
  const solo = auditarAgente({ ...AFA, empresa_contexto: AFA_REGLA_NUEVA }, CTX_AFA);
  ok(!solo.hallazgos.some((h) => h.alarma && (h.tema === "preguntas" || h.tema === "resumen")), "el texto real nuevo: ninguna alarma de preguntas ni de resumen");
  ok(solo.hallazgos.filter((h) => h.codigo === "preguntas.duplica").length === 10, "el texto real nuevo: sus 10 frases de «todo junto» repiten el ajuste (gris)");
  const agregado = auditarAgente({ ...AFA, empresa_contexto: `${AFA_EMPRESA}\n\n${AFA_REGLA_NUEVA}` }, CTX_AFA);
  ok(igual(firma(agregado.hallazgos.filter((h) => h.alarma)), ESPERADO_AFA_AMBAR), "agregado al texto de siempre: las mismas 13 alarmas del caso AFA, ninguna del texto nuevo");
}
// «Salvo los traslados» deja fuera lo que cotiza el sistema.
{
  const r = auditarAgente({ empresa_contexto: "Urgencias para hoy, salvo los traslados: comuníquese al 999 888 777." }, { trasladosActivos: true });
  ok(!r.hallazgos.some((h) => h.codigo === "traslados.hoy"), "«salvo los traslados» apaga el aviso de urgencias para hoy");
}
// La plantilla de derivación propia en el trato correcto no avisa; vacía no se audita.
{
  const r = auditarAgente({ mensaje_derivacion: "Gracias, {nombre}. Un ejecutivo le escribirá por este chat." });
  ok(r.hallazgos.length === 0, "derivación propia de usted con trato usted → nada");
  const r2 = auditarAgente({ mensaje_derivacion: "Gracias, {nombre}. {atencion}", comportamiento: { atencion_activa: true } });
  ok(r2.hallazgos.length === 0, "derivación propia con {atencion} y horario declarado → nada");
}

// ── 6. Invariantes ─────────────────────────────────────────────────────────────────────────────────
const TODAS: { r: ReturnType<typeof auditarAgente>; cfg: ConfigAuditable }[] = [
  { r: rAfa, cfg: AFA }, { r: rRec, cfg: { ...AFA, comportamiento: RECOMENDADO } },
  { r: auditarAgente({ ...AFA, comportamiento: { ...AFA_COMPORTAMIENTO, tratamiento: "tu", preguntas: "una_por_mensaje" } }, CTX_AFA), cfg: { ...AFA, comportamiento: { ...AFA_COMPORTAMIENTO, tratamiento: "tu" } } },
  { r: auditarAgente({ ...AFA, comportamiento: { ...AFA_COMPORTAMIENTO, resumen_pedido: false, ocultar_ia: false, leer_archivos: false, atencion_activa: true, atencion_desde: "18:00", atencion_hasta: "09:00" } }, CTX_AFA), cfg: AFA },
  ...CASOS.map((k) => { const cfg = { nombre: "Ana", ...k.cfg }; return { r: auditarAgente(cfg, k.ctx ?? { empresa: "ACME" }), cfg }; }),
];
{
  let malas = 0, citasMalas = 0, dup = 0, orden = 0, conteo = 0, anclas = 0;
  for (const { r, cfg } of TODAS) {
    const textoDe = (campo: string | null, indice?: number): string[] => {
      if (campo === "goals") { const g = (cfg.goals as { titulo: string; instrucciones: string }[])[indice! - 1]; return [g.titulo, g.instrucciones]; }
      if (campo === "reglas_extra") return [String((cfg.comportamiento as Record<string, unknown>)?.reglas_extra ?? "")];
      if (campo) return [String((cfg as Record<string, unknown>)[campo] ?? "")];
      return [];
    };
    for (const h of r.hallazgos) {
      if (h.alarma !== TABLA_HALLAZGOS[h.codigo].alarma || h.relacion !== TABLA_HALLAZGOS[h.codigo].relacion || h.titulo !== TABLA_HALLAZGOS[h.codigo].titulo) malas++;
      if (!h.codigo.startsWith(`${h.tema}.`)) malas++;
      const sinCorte = h.cita.endsWith("…") ? h.cita.slice(0, -1) : h.cita;
      if (Array.from(h.cita).length > 200) citasMalas++;
      if (h.campo && !textoDe(h.campo, h.indice).some((t) => t.includes(sinCorte))) citasMalas++;
      if (h.otra && !textoDe(h.otra.campo, h.otra.indice).some((t) => t.includes(h.otra!.cita.replace(/…$/, "")))) citasMalas++;
      if (!h.campo && !h.cita) citasMalas++;
      if (h.ajuste && !Object.values(TEMAS_AJUSTE).some((t) => t.ancla === h.ajuste!.ancla)) anclas++;
      if (!h.arreglo || !h.titulo || !h.etiquetaCampo) malas++;
    }
    if (new Set(r.hallazgos.map(claveHallazgo)).size !== r.hallazgos.length) dup++;
    const a = r.hallazgos.findIndex((h) => !h.alarma);
    if (a >= 0 && r.hallazgos.slice(a).some((h) => h.alarma)) orden++;
    const porTema = r.hallazgos.filter((h) => h.alarma).reduce((m, h) => ({ ...m, [h.tema]: ((m as Record<string, number>)[h.tema] ?? 0) + 1 }), {});
    if (!igual(Object.entries(porTema).sort(), Object.entries(r.porTema).sort()) || r.alarmas + r.grises !== r.hallazgos.length) conteo++;
  }
  ok(malas === 0, "alarma, relación y título son SIEMPRE los de la tabla; el código empieza por su tema; todo trae arreglo");
  ok(citasMalas === 0, "toda cita (sin «…») es subcadena de su campo, y no pasa de 200 caracteres");
  ok(dup === 0, "sin duplicados (una clave por hallazgo)");
  ok(orden === 0, "alarmas primero en todas las auditorías");
  ok(conteo === 0, "porTema cuenta las alarmas; alarmas + grises = hallazgos");
  ok(anclas === 0, "todo ajuste nombrado lleva un ancla de TEMAS_AJUSTE");
}
// Config vacía + defaults → 0 hallazgos.
for (const cfg of [{}, { comportamiento: null }, { comportamiento: AJUSTES_DEFECTO }, { comportamiento: "basura" }, { persona: "", empresa_contexto: "   ", goals: [] }] as ConfigAuditable[])
  ok(auditarAgente(cfg, { trasladosActivos: true }).hallazgos.length === 0, `config vacía ${JSON.stringify(cfg).slice(0, 40)} → 0 hallazgos`);
ok(auditarAgente(undefined as unknown as ConfigAuditable).hallazgos.length === 0, "config undefined → 0 hallazgos (no revienta)");
ok(auditarAgente({ goals: [null, "x", { titulo: 3 }] } as unknown as ConfigAuditable).hallazgos.length === 0, "objetivos raros → no revienta");
// Determinista.
ok(igual(auditarAgente(AFA, CTX_AFA), rAfa), "determinista: dos auditorías iguales dan lo mismo");
// nuevasAlarmas: agregar una frase que choca da exactamente esa alarma; las grises no cuentan.
{
  const mas = auditarAgente({ ...AFA, conocimiento: `${AFA_CONOCIMIENTO}\nTutea al cliente.\nEl resumen va solo al final.` }, CTX_AFA);
  const nuevas = nuevasAlarmas(rAfa.hallazgos, mas.hallazgos);
  ok(nuevas.length === 1 && nuevas[0].codigo === "tratamiento.contradice" && nuevas[0].cita === "Tutea al cliente.", "nuevasAlarmas: solo la frase nueva que choca (la gris no cuenta)");
  ok(nuevasAlarmas(rAfa.hallazgos, rAfa.hallazgos).length === 0, "nuevasAlarmas: sin cambios → ninguna");
}
// Las etiquetas de campo existen y no hay palabras de una empresa concreta en el motor.
ok(Object.values(ETIQUETA_CAMPO).every(Boolean), "toda etiqueta de campo tiene texto");
{
  const fuente = readFileSync(new URL("../lib/crm-ia-coherencia.ts", import.meta.url), "utf8");
  ok(!/\bAFA\b|AFITA|afatours|966 ?707|Primax|COESTI/i.test(fuente), "el motor no nombra a ninguna empresa (el ERP se vende)");
  ok(!/from ["'](@\/lib\/supabase|.*fetch|next\/)/.test(fuente) && !/\bfetch\(|Anthropic|new Date\(\)/.test(fuente), "el motor es PURO: sin base, sin fetch, sin IA, sin reloj");
}
// partirFrases: no corta dentro de comillas ni de paréntesis, ni tras «Sr.»; sí entre oraciones.
{
  const fr = partirFrases('Hola. Molestia: "Lo siento. Le comunico." (Activa silencio. Ya.) Llega el Sr. Pérez.\nFin del texto').map((f) => f.texto);
  ok(igual(fr, ["Hola.", 'Molestia: "Lo siento. Le comunico." (Activa silencio. Ya.)', "Llega el Sr. Pérez.", "Fin del texto"]), `partirFrases respeta comillas, paréntesis y abreviaturas (${JSON.stringify(fr)})`);
}
// Corolario: el caso AFA da alarmas (un auditor que no avisara nunca cumpliría todo lo demás).
ok(rAfa.alarmas > 0 && rRec.alarmas > 0, "corolario: el caso AFA da alarmas");

// Anclas: cada ajuste.ancla tiene que existir como `id` en la pantalla. PENDIENTE hasta que T5 ponga
// los id en components/crm/AjustesComportamiento.tsx o app/crm/agente/page.tsx: mientras tanto
// informa con ⏳ y no falla. La sesión principal la activa poniendo ANCLAS_OBLIGATORIAS = true.
const ANCLAS_OBLIGATORIAS = false;
{
  const leer = (p: string) => { try { return readFileSync(new URL(`../${p}`, import.meta.url), "utf8"); } catch { return ""; } };
  const fuentes = leer("components/crm/AjustesComportamiento.tsx") + "\n" + leer("app/crm/agente/page.tsx");
  const faltan: string[] = [];
  for (const [tema, t] of Object.entries(TEMAS_AJUSTE)) {
    const literal = new RegExp(`id=\\{?["'\`]${t.ancla}["'\`]\\}?`).test(fuentes);
    const porConstante = new RegExp(`TEMAS_AJUSTE(\\.${tema}|\\[["']${tema}["']\\])\\.ancla`).test(fuentes);
    if (!literal && !porConstante && !faltan.includes(t.ancla)) faltan.push(t.ancla);
  }
  if (ANCLAS_OBLIGATORIAS) ok(faltan.length === 0, `toda ancla de ajuste existe como id en la pantalla${faltan.length ? ` (faltan: ${faltan.join(", ")})` : ""}`);
  else console.log(faltan.length ? `⏳ anclas pendientes hasta la pantalla: faltan ${faltan.length} (${faltan.join(", ")})` : "✓ anclas: todas existen como id en la pantalla (ya se puede poner ANCLAS_OBLIGATORIAS = true)");
}

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
