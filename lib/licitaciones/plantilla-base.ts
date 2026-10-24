// lib/licitaciones/plantilla-base.ts — La propuesta técnica de arranque: la ESTRUCTURA de una propuesta
// real de transporte de personal (veinte secciones), con texto genérico. Módulo PURO.
//
// Reglas de la plantilla, y por qué:
//  · NI UNA CIFRA (ningún número de dos o más dígitos): un plazo, una meta, un porcentaje o un tiempo de
//    respuesta escritos aquí se imprimirían como compromisos que nadie revisó. Donde va un número va
//    [COMPLETAR] o una {variable} que sale del ERP. La numeración de secciones la pone el motor.
//  · NINGÚN nombre de empresa, cliente, persona, placa ni teléfono: este ERP se vende, y todo lo de la
//    empresa sale de {variables} (perfil de la empresa) y de la licitación.
//  · Las tablas que el ERP sabe armar (datos del postor, unidades, conductores, matriz, consultas,
//    experiencia, contactos, adjuntos) son bloques AUTOMÁTICOS: no se teclean.
// La matriz (scripts/prueba-licitaciones-revision.mts) barre todo el texto con expresiones regulares.

import { expedientePorDefecto } from "./expediente";
import { docVacio } from "./normalizar";
import type { Bloque, DocLicitacion, Seccion, TipoAuto } from "./tipos";

const C = "[COMPLETAR]";

/** Arma una sección con bloques (los ids los pone `nuevoId`). */
function constructor(nuevoId: () => string) {
  const P = (texto: string): Bloque => ({ id: nuevoId(), tipo: "parrafo", texto });
  const S = (texto: string, nivel: 2 | 3 = 2): Bloque => ({ id: nuevoId(), tipo: "subtitulo", texto, nivel, numerado: true });
  const V = (items: string[], ordenada = false): Bloque => ({ id: nuevoId(), tipo: "vinetas", items, ordenada });
  const T = (columnas: string[], filas: string[][]): Bloque => ({ id: nuevoId(), tipo: "tabla", titulo: null, columnas, filas, anchos: null });
  const A = (auto: TipoAuto, titulo: string | null = null): Bloque => ({ id: nuevoId(), tipo: "auto", auto, titulo, filasExtra: [], conContacto: false });
  const N = (texto: string): Bloque => ({ id: nuevoId(), tipo: "nota", texto, tono: "info" });
  const sec = (titulo: string, bloques: Bloque[]): Seccion => ({ id: nuevoId(), titulo, activa: true, numerada: true, bloques });
  return { P, S, V, T, A, N, sec };
}

/** Las veinte secciones de la plantilla base. */
export function seccionesBase(nuevoId: () => string): Seccion[] {
  const { P, S, V, T, A, N, sec } = constructor(nuevoId);
  return [
    sec("Resumen ejecutivo", [
      P(`{empresa} propone a {cliente} el servicio de {objeto}, conforme a las bases del concurso {concurso}. ${C} La propuesta se sostiene en los siguientes pilares:`),
      T(["Pilar", "Qué ofrecemos"], [["**Seguridad**", C], ["**Puntualidad**", C], ["**Continuidad operativa**", C], ["**Tecnología**", C], ["**Gestión del contrato**", C]]),
      S("Cifras clave del servicio"),
      T(["Indicador", "Valor"], [
        ["Rutas del servicio", C], ["Unidades titulares", "{n_titulares}"], ["Unidades de retén", "{n_reten}"],
        ["Asientos ofertados", "{asientos_ofertados}"], ["Conductores asignados", "{n_conductores}"],
        ["Plazo del servicio", "{plazo_meses} meses"], ["Inicio del servicio", "{fecha_inicio}"],
      ]),
      S("Por qué {empresa}"),
      V([
        `**Experiencia comprobada.** {anios_experiencia} años de experiencia acreditada en transporte de personal. ${C}`,
        `**Base operativa.** ${C}`,
        "**Continuidad garantizada.** Unidades de retén y conductores de relevo para cubrir fallas y ausencias sin interrumpir el servicio.",
        "**Un solo interlocutor.** Administrador de contrato dedicado e indicadores medibles desde el inicio.",
      ]),
    ]),
    sec("Presentación del postor", [
      S("Datos generales"), A("datos_postor"),
      S("Misión, visión y valores"),
      P(`**Misión:** ${C}`), P(`**Visión:** ${C}`), P(`**Valores:** ${C}`),
      S("Experiencia y clientes"),
      P("{empresa} acredita la siguiente experiencia en servicios de transporte de personal, por un importe total de {total_experiencia}:"),
      A("cuadro_experiencia"),
      S("Infraestructura y capacidades"),
      V([`Bases operativas y patios de unidades: ${C}`, "Central de monitoreo con visualización GPS de toda la flota y atención de alertas.", `Taller y áreas de soporte: ${C}`]),
    ]),
    sec("Comprensión del servicio y alcance", [
      S("Objeto"), P(`{objeto}. ${C}`),
      S("Alcance del servicio"), T(["Bloque", "Horario", "Rutas", "Frecuencia"], [[C, C, C, C]]),
      S("Factores críticos de éxito identificados"), T(["Factor crítico", "Implicancia y respuesta"], [[C, C]]),
    ]),
    sec("Cumplimiento de requisitos mínimos", [
      P("La siguiente matriz consolida el cumplimiento de los requisitos de las bases del concurso {concurso} y de la absolución de consultas, con el documento que los sustenta."),
      A("matriz_cumplimiento"),
      S("Incorporación de la absolución de consultas"),
      P("Las respuestas de {cliente} a las consultas forman parte de esta propuesta. La tabla resume cada respuesta y cómo la incorpora {empresa}."),
      A("absolucion_consultas"),
    ]),
    sec("Metodología de gestión del servicio", [
      P("{empresa} gestiona sus contratos de transporte de personal con el ciclo de mejora continua PHVA. Cada etapa tiene responsables, herramientas y entregables definidos."),
      T(["Etapa", "Actividades", "Herramientas / entregables"], [
        ["Planificar", "Validación de rutas, dimensionamiento de flota y conductores, programación de turnos y matriz de riesgos.", C],
        ["Hacer", "Checklist previo al viaje, ejecución de rutas, control de abordaje, monitoreo GPS y atención de incidencias.", C],
        ["Verificar", "Medición de indicadores, auditorías de unidades y encuestas de satisfacción.", C],
        ["Actuar", "Análisis de causa raíz, acciones correctivas y ajuste de rutas y horarios.", C],
      ]),
    ]),
    sec("Ingeniería de rutas", [
      S("Criterios de diseño y validación"),
      V([
        "Secuencia lógica de paraderos, sin retrocesos ni recorridos redundantes.",
        "Tiempo razonable a bordo y llegada al destino antes de la hora exigida.",
        "Paraderos seguros: iluminación, visibilidad y espacio para detenerse sin obstruir el tránsito.",
        "Corredores principales y alternos para cada ruta ante congestión, obras o cierres.",
      ]),
      S("Caracterización de las rutas"), T(["Ruta", "Distritos", "Corredores principales", "Paraderos", "Llegada"], [[C, C, C, C, C]]),
      S("Política de puntualidad en ruta"),
      T(["Regla", "Detalle"], [
        ["Presentación en el primer paradero", C],
        ["Paso por paraderos", "Nunca antes de la hora programada; si la unidad va adelantada, espera en un punto seguro."],
        ["Desfase", "Alerta automática a la central, que evalúa una ruta alterna y avisa a los pasajeros y al cliente."],
      ]),
      S("Gestión de cambios de ruta"),
      V(["El cliente solicita el cambio por el canal formal.", "Se evalúa el impacto en tiempo, distancia y seguridad.", "Se presenta la propuesta y el cliente la aprueba por escrito.", "Se actualiza la programación y se comunica el cambio a pasajeros y conductores."], true),
    ]),
    sec("Dimensionamiento y asignación de flota", [
      S("Cálculo de flota requerida"),
      P(`El servicio se atiende con {n_titulares} unidades titulares y {n_reten} unidades de retén de similares características. ${C}`),
      S("Asignación de unidades por ruta"), A("relacion_unidades"),
      S("Especificaciones técnicas: exigido vs. ofertado"), A("exigido_ofertado"),
    ]),
    sec("Gestión del personal de conducción", [
      S("Dimensionamiento de conductores"),
      P(`El servicio cuenta con {n_conductores} conductores asignados, de los cuales {n_relevo} son de relevo para cubrir descansos, licencias y contingencias. ${C}`),
      A("conductores"),
      S("Jornadas, descansos y control de fatiga"),
      P(`Los turnos se programan según la normativa laboral vigente y los tiempos de conducción y descanso del reglamento de transporte. ${C}`),
      S("Perfil del conductor"),
      T(["Requisito", "Estándar"], [
        ["Licencia", "Categoría profesional vigente acorde al tipo de unidad"],
        ["Récord del conductor", "Sin infracciones graves ni muy graves"],
        ["Salud", "Examen médico ocupacional vigente y evaluación psicosensométrica"],
        ["Antecedentes", "Certificados penales y policiales sin registros"],
      ]),
      S("Plan anual de capacitación"),
      T(["Tema", "Frecuencia", "Sustento"], [["Manejo defensivo", C, "Certificado"], ["Primeros auxilios", C, "Certificado"], [C, C, C]]),
    ]),
    sec("Mantenimiento y gestión de flota", [
      S("Programa de mantenimiento preventivo"), P(C),
      S("Control documental de la flota"),
      T(["Documento", "Control", "Alerta"], [["SOAT", "Vigencia por unidad", C], ["Revisión técnica", "Vigencia por unidad", C], ["Licencias y exámenes médicos", "Vigencia por conductor", C]]),
      S("Protocolo de limpieza y desinfección"), P(C),
    ]),
    sec("Plataforma tecnológica", [
      P(`${C} (control de abordaje, monitoreo GPS, aplicaciones para pasajeros y conductores, y portal del cliente).`),
    ]),
    sec("Seguridad y gestión de riesgos", [
      S("Política de seguridad vial"),
      P("La seguridad de los pasajeros es un valor no negociable: conductores competentes y descansados, vehículos en óptimas condiciones, rutas seguras, monitoreo permanente y respuesta inmediata ante emergencias."),
      S("Matriz de riesgos operativos"),
      T(["Riesgo", "Probabilidad", "Impacto", "Control / mitigación"], [
        ["Retraso por congestión vehicular", C, C, C], ["Falla mecánica en ruta", C, C, C],
        ["Ausencia del conductor", C, C, C], ["Documentación vencida", C, C, C],
      ]),
      S("Protocolo de emergencia"),
      T(["Evento", "Acción", "Comunicación al cliente"], [["Accidente de tránsito", C, "Inmediata"], ["Falla mecánica en ruta", C, "Inmediata"], ["Emergencia médica", C, "Inmediata"]]),
      S("Seguros"),
      T(["Póliza", "Cobertura"], [["SOAT", "Por unidad, vigente todo el contrato"], ["Responsabilidad civil frente a terceros", C], ["SCTR", "Salud y pensión para conductores y personal operativo"]]),
    ]),
    sec("Plan de contingencias y continuidad del servicio", [
      T(["Contingencia", "Respuesta", "Tiempo comprometido"], [
        ["Falla mecánica en ruta", "Unidad de retén al punto de la falla", C],
        ["Ausencia de conductor", "Conductor de relevo asignado por la central", C],
        ["Cierre de vías o manifestaciones", "Ruta alterna preaprobada y aviso a los pasajeros", "Inmediato"],
      ]),
      S("Niveles de escalamiento"),
      T(["Nivel", "Responsable", "Tiempo de atención", "Casos"], [
        ["Primero", "Central de monitoreo", "Inmediato", "Retrasos, desvíos y consultas operativas"],
        ["Segundo", "Jefe de operaciones", C, "Fallas, ausencias y reemplazos de unidad"],
        ["Tercero", "Administrador del contrato", C, "Incidentes con pasajeros, quejas y penalidades"],
        ["Cuarto", "Gerencia general", C, "Accidentes graves y temas contractuales"],
      ]),
    ]),
    sec("Administración y gobierno del contrato", [
      S("Roles y responsabilidades"),
      T(["Rol", "Responsabilidades"], [
        ["Administrador del contrato", "Interlocutor único con el cliente; seguimiento de indicadores, reportes, penalidades y facturación."],
        ["Jefe de operaciones", "Programación diaria, asignación de unidades y conductores, cumplimiento de rutas y horarios."],
        ["Central de monitoreo", "Seguimiento GPS, alertas, registro de incidencias y comunicación con pasajeros."],
      ]),
      S("Datos de contacto"), A("contactos"),
      S("Comités y reuniones de seguimiento"),
      T(["Instancia", "Frecuencia", "Contenido"], [["Reporte operativo", "Diario", "Servicios ejecutados, puntualidad, pasajeros e incidencias"], ["Comité operativo", "Mensual", "Revisión de indicadores, penalidades, quejas y plan de acción"]]),
    ]),
    sec("Indicadores de desempeño (SLA)", [
      T(["Indicador", "Fórmula", "Meta", "Frecuencia", "Fuente"], [
        ["Puntualidad de llegada", "Servicios a tiempo / servicios de ingreso", C, "Diaria", "GPS"],
        ["Cumplimiento de servicios", "Servicios ejecutados / servicios programados", C, "Diaria", "Sistema"],
        ["Disponibilidad de flota", "Días-unidad operativos / días-unidad programados", C, "Mensual", "Sistema"],
      ]),
      N("Las metas se fijan con el cliente al inicio del contrato y se miden con los registros del sistema."),
    ]),
    sec("Atención y experiencia del pasajero", [
      S("Código de conducta del conductor"),
      V(["Saludo cordial y trato respetuoso a todos los pasajeros.", "Uniforme completo e identificación visible.", "Conducción suave, sin maniobras bruscas y respetando los límites de velocidad.", "Prohibido el uso del celular mientras conduce."]),
      S("Comunicación con los pasajeros"), P(C),
    ]),
    sec("Gestión ambiental", [
      V(["Conducción eficiente para reducir el consumo y las emisiones.", "Mantenimiento preventivo para mantener las emisiones dentro de los límites permitidos.", "Disposición adecuada de aceites, filtros y llantas usadas.", "Reducción de papel: manifiestos, reportes y facturas en formato digital."]),
    ]),
    sec("Plan de implementación y transición", [
      T(["Actividad", "Plazo", "Responsable", "Entregable"], [
        ["Adjudicación, firma del contrato y pólizas", C, "Gerencia", "Contrato y pólizas"],
        ["Asignación de unidades e inspección conjunta", C, "Jefe de mantenimiento", "Acta de inspección"],
        ["Asignación de conductores e inducción", C, "Jefe de operaciones", "Registro de inducción"],
        ["Inicio del servicio con supervisión reforzada", "{fecha_inicio}", "Todo el equipo", "Reporte diario"],
      ]),
    ]),
    sec("Forma de facturación y pago", [
      T(["Aspecto", "Condición propuesta"], [["Tarifa", C], ["Base de facturación", "Pago por los servicios efectivamente prestados"], ["Comprobante", `Factura electrónica ${C}`], ["Condición de pago", C]]),
    ]),
    sec("Compromisos del postor", [
      V([
        "Prestar el servicio en las rutas, días y horarios de las bases y de la absolución de consultas.",
        "Mantener durante todo el contrato unidades con capacidad y antigüedad iguales o mejores que las ofertadas.",
        "Mantener vigentes el SOAT, la revisión técnica, las pólizas, el SCTR y las licencias.",
        "Comunicar al cliente, antes de su ejecución, cualquier cambio de conductor o unidad.",
        "Guardar confidencialidad sobre la información del cliente y de sus colaboradores.",
      ]),
    ]),
    sec("Relación de documentos adjuntos", [
      P("La documentación se presenta en el orden indicado a continuación, con una portada separadora por bloque para facilitar su revisión."),
      A("relacion_adjuntos"),
    ]),
  ];
}

/** Un documento nuevo desde la plantilla base: preliminares, las veinte secciones y el expediente completo. */
export function docDesdePlantilla(nuevoId: () => string): DocLicitacion {
  const d = docVacio(nuevoId);
  const doc: DocLicitacion = {
    ...d,
    portada: { ...d.portada, titulo: "Propuesta Técnica", subtitulo: "{objeto}" },
    control: {
      ...d.control, activo: true, documento: "Propuesta Técnica — {objeto}", version: "",
      elaboradoPor: "Área de Operaciones", revisadoPor: C, aprobadoPor: "{representante} — {cargo_representante}",
      confidencialidad: "Documento de uso exclusivo para el concurso {concurso} de {cliente}",
    },
    carta: {
      ...d.carta, activa: true,
      cuerpo: [
        "Presente.-",
        "De nuestra consideración:",
        "{razon_social}, con RUC N° {ruc}, representada por su {cargo_representante}, {representante}, identificado con DNI N° {dni_representante}, presenta su Propuesta Técnica para el servicio de {objeto} de {cliente}, conforme a las bases del concurso {concurso} y a la absolución de consultas.",
        `La propuesta incluye ${C}.`,
        "Declaramos conocer y aceptar las bases, sus anexos, la absolución de consultas y el régimen de penalidades, y nos comprometemos a mantener las condiciones ofertadas durante todo el proceso de evaluación y la vigencia del contrato.",
      ].join("\n\n"),
      despedida: "Atentamente,", conFirma: true,
    },
    glosario: {
      activo: true,
      entradas: [
        ["SLA", "Acuerdo de nivel de servicio: indicador, meta y frecuencia de medición comprometidos."],
        ["PHVA", "Ciclo de mejora continua: Planificar, Hacer, Verificar, Actuar."],
        ["Unidad titular", "Vehículo asignado de forma fija a una ruta."],
        ["Unidad de retén", "Vehículo de similares características, disponible para reemplazar a una unidad titular."],
        ["Conductor de relevo", "Conductor que cubre descansos, licencias y contingencias de los titulares."],
        [C, "Términos propios del cliente y de sus bases."],
      ].map(([termino, definicion]) => ({ id: nuevoId(), termino, definicion })),
    },
    indice: { activo: true, niveles: 2 },
    secciones: seccionesBase(nuevoId),
    cierre: { activo: true, texto: "En señal de conformidad y compromiso con los términos de la presente propuesta, firma el representante legal de {razon_social}.", conFirma: true },
  };
  doc.expediente = expedientePorDefecto(doc, null, nuevoId);
  return doc;
}
