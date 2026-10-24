// lib/licitaciones/revision.ts — Los HALLAZGOS de una licitación: contradicciones, faltantes y avisos,
// cada uno con su código declarado, su arreglo y DÓNDE se corrige. Módulo PURO.
//
// Ningún hallazgo bloquea la emisión (D7): la revisión informa, la persona decide y puede ACEPTAR un
// hallazgo con una nota (HallazgoAceptado, por su `clave` estable). Reglas que no se aflojan:
//  (a) una fuente que no se pudo leer produce UN `fuente_no_leida` y ningún «falta» de esa fuente;
//  (b) `requisito_no_cumple` solo en requisitos SIN regla marcados «no cumple» a mano (los que tienen
//      regla ya hablan por sus hallazgos específicos, que llevan el requisito);
//  (c) obligatorio sin resolver (pendiente o no juzgable) → `requisito_obligatorio_pendiente`;
//  (d) los documentos de una unidad (y de un conductor, y una póliza) solo se juzgan si una regla los
//      pide o si el expediente los incluye;
//  (e) la experiencia se totaliza POR MONEDA, nunca se suman PEN y USD;
//  (f-h) el texto: menciones de otra licitación, «flota propia» con recursos tercerizados, y una
//      autorización que no es la del perfil (nunca se afirma cuál es la correcta);
//  (i) tri-estado: sin año la antigüedad no se juzga, nunca «cumple»;
//  (k) la fecha de referencia es la de presentación, o hoy si falta (y se dice).
//
// Un mismo problema no se cuenta dos veces: lo que una regla ya nombró (con su requisito) no lo repite
// el control genérico ni el del expediente (`yaHay` mira código y sujeto).
//
// `donde.ancla`: el nombre del panel del editor ("datos", "requisitos", "unidades", "conductores",
// "experiencia", "contactos", "representante", "secciones", "expediente", "foliado", "hallazgos") o el
// elemento concreto como "<tipo>:<id>" ("requisito:…", "unidad:p:12", "bloque:…", "seccion:…",
// "bloque_expediente:…", "item:…"), para que el editor lleve a él.

import { empresaConDefectos } from "../empresa-perfil";
import { origenArchivo } from "./archivos";
import { estadoLegajo, fijadoExiste, tipoLegajo, tipoDocConductor, documentoVigente, archivosConductor } from "./legajo";
import { resumenUnidad, vigencia } from "./recursos";
import { evaluarReglaDetallada, NOMBRE_FUENTE, sujetoConductor, sujetoUnidad, type ProblemaRegla, type ResultadoRegla } from "./reglas";
import { autorizacionDelPerfil, escanearTexto, mismaAutorizacion, representanteDe, totalesExperiencia, type LugarTexto } from "./texto";
import { resolverExpediente } from "./expediente";
import {
  GRAVEDAD_HALLAZGO, PASOS,
  type CategoriaRequisito, type CodigoHallazgo, type ContextoLicitacion, type DondeSeCorrige, type EvaluacionRequisito,
  type FechaISO, type FilaEmision, type FuenteContexto, type Gravedad, type Hallazgo, type Licitacion, type Paso,
  type Regla, type Revision, type RevisionArchivo, type SujetoHallazgo,
} from "./tipos";
import { fechaDMY, fechaONull, diasISO } from "./util";

const P = (paso: Paso, ancla: string | null = null): DondeSeCorrige => ({ paso, ancla });
const R = (ruta: string, etiqueta: string): DondeSeCorrige => ({ ruta, etiqueta });

const LEGAJO = R("/licitaciones?tab=legajo", "Licitaciones → Legajo de la empresa");
const EXPERIENCIA = R("/licitaciones?tab=experiencia", "Licitaciones → Experiencia");
const PERFIL = R("/configuracion/perfil", "Configuración → Perfil de la empresa");
const DOCS_VEH = R("/documentos-vehiculares", "Docs. Vehiculares");

/** Una entrada por código: qué es, qué hacer y dónde. La matriz exige que estén todos. */
export const CATALOGO_HALLAZGOS: Record<CodigoHallazgo, { titulo: string; arreglo: string; donde: DondeSeCorrige }> = {
  // ── Licitación y empresa
  fecha_presentacion_pasada: { titulo: "La fecha de presentación ya pasó", arreglo: "Corrige la fecha de presentación en Bases y requisitos, o cambia el estado de la licitación si ya se presentó.", donde: P("bases", "datos") },
  falta_fecha_presentacion: { titulo: "Falta la fecha de presentación", arreglo: "Escribe la fecha de presentación en Bases y requisitos: mientras falte, las vigencias se miden contra hoy.", donde: P("bases", "datos") },
  falta_fecha_inicio: { titulo: "Falta la fecha de inicio del servicio", arreglo: "Escribe la fecha de inicio en Bases y requisitos para comprobar qué documento vence antes de empezar.", donde: P("bases", "datos") },
  fuente_no_leida: { titulo: "No se pudo leer una fuente del ERP", arreglo: "Recarga la página. Si sigue igual, revisa la conexión o la migración nombrada; mientras tanto no se afirma que falte nada de esa fuente.", donde: P("revision", "hallazgos") },
  perfil_incompleto: { titulo: "El perfil de la empresa está incompleto", arreglo: "Completa los datos que faltan en Configuración → Perfil de la empresa: salen en la portada, los datos del postor y el pie.", donde: PERFIL },
  autorizacion_sin_perfil: { titulo: "El perfil no tiene la autorización de transporte", arreglo: "Escribe la autorización del regulador en Configuración → Perfil de la empresa para poder cotejar la del texto.", donde: PERFIL },
  autorizacion_mtc_distinta: { titulo: "La autorización del texto no es la del perfil", arreglo: "Revisa cuál es la vigente y corrige el texto de la propuesta o el perfil de la empresa.", donde: P("contenido", "secciones") },
  representante_incompleto: { titulo: "Faltan datos del representante legal", arreglo: "Completa nombre, DNI y cargo en Recursos → Representante legal, o elige a la persona del personal administrativo.", donde: P("recursos", "representante") },
  firma_falta: { titulo: "Falta la firma del representante", arreglo: "Sube la imagen de la firma en Recursos → Representante legal.", donde: P("recursos", "representante") },
  // ── Requisitos
  requisito_obligatorio_pendiente: { titulo: "Requisito obligatorio sin resolver", arreglo: "Marca el requisito (cumple, no cumple o no aplica) en Bases y requisitos, o completa los datos que su regla necesita.", donde: P("bases", "requisitos") },
  requisito_no_cumple: { titulo: "Requisito marcado «no cumple»", arreglo: "Resuelve el incumplimiento, o acepta el hallazgo con una nota si se presenta así a propósito.", donde: P("bases", "requisitos") },
  requisito_no_juzgable: { titulo: "Un requisito no se puede comprobar con el ERP", arreglo: "Completa el dato que falta (ver el detalle) o marca el requisito a mano en Bases y requisitos.", donde: P("bases", "requisitos") },
  requisito_manual_contradice: { titulo: "La marca manual contradice la comprobación del ERP", arreglo: "Revisa el detalle de la regla. Si tu marca es la correcta, acepta el hallazgo con una nota.", donde: P("bases", "requisitos") },
  requisito_sin_sustento: { titulo: "Requisito sin sustento en la matriz", arreglo: "Escribe qué documento lo sustenta (columna «Sustento adjunto») en Bases y requisitos.", donde: P("bases", "requisitos") },
  requisito_sin_documento_en_expediente: { titulo: "El requisito no tiene dónde ir en el expediente", arreglo: "Elige el bloque del expediente de su documento en Bases y requisitos y agrega el documento en Expediente.", donde: P("expediente", "expediente") },
  // ── Unidades
  unidad_no_existe: { titulo: "La unidad ya no existe en el ERP", arreglo: "Quítala en Recursos, o regístrala en Vehículos o Tercerizadas y vuelve a elegirla.", donde: P("recursos", "unidades") },
  unidad_inactiva: { titulo: "Unidad inactiva", arreglo: "Cámbiala en Recursos o actívala en su ficha.", donde: P("recursos", "unidades") },
  unidad_repetida: { titulo: "La misma unidad está elegida dos veces", arreglo: "Quita la repetida en Recursos.", donde: P("recursos", "unidades") },
  unidad_codigo_repetido: { titulo: "Dos unidades con el mismo código", arreglo: "Cambia el código (U1, U2, R1…) de una de ellas en Recursos.", donde: P("recursos", "unidades") },
  unidad_tercerizada_prohibida: { titulo: "Unidad tercerizada en un concurso que no permite subcontratar", arreglo: "Reemplázala en Recursos por una unidad propia, o confirma por escrito con el cliente que la cesión de uso está permitida.", donde: P("recursos", "unidades") },
  unidad_sin_anio: { titulo: "Unidad sin año de fabricación", arreglo: "Escribe el año en Recursos (se guarda en la ficha de la unidad) o en su ficha: sin él no se puede comprobar la antigüedad.", donde: P("recursos", "unidades") },
  unidad_excede_antiguedad: { titulo: "Unidad más antigua que lo permitido", arreglo: "Reemplázala en Recursos por una unidad dentro del límite.", donde: P("recursos", "unidades") },
  unidad_sin_capacidad: { titulo: "Unidad sin capacidad registrada", arreglo: "Completa los asientos en la ficha de la unidad (Vehículos o Tercerizadas).", donde: R("/vehiculos", "Vehículos") },
  unidad_capacidad_insuficiente: { titulo: "Capacidad menor a la exigida", arreglo: "Elige en Recursos una unidad con más asientos.", donde: P("recursos", "unidades") },
  unidad_doc_falta: { titulo: "Falta un documento de la unidad", arreglo: "Regístralo con su PDF en Docs. Vehiculares (flota propia) o en Tercerizadas.", donde: DOCS_VEH },
  unidad_doc_vencido_al_presentar: { titulo: "Documento de la unidad vencido a la presentación", arreglo: "Registra el documento renovado en Docs. Vehiculares (o Tercerizadas), o cambia la unidad.", donde: DOCS_VEH },
  unidad_doc_vence_antes_inicio: { titulo: "El documento vence antes del inicio del servicio", arreglo: "Prevé su renovación y regístrala en Docs. Vehiculares (o Tercerizadas) antes de empezar.", donde: DOCS_VEH },
  unidad_doc_sin_archivo: { titulo: "Documento de la unidad sin PDF", arreglo: "Sube el PDF del documento en Docs. Vehiculares (o Tercerizadas): sin archivo no se puede adjuntar.", donde: DOCS_VEH },
  unidad_doc_archivo_externo: { titulo: "El documento es un enlace externo", arreglo: "Sube el PDF en Docs. Vehiculares (o Tercerizadas): un enlace de Drive no se puede unir al expediente.", donde: DOCS_VEH },
  unidad_sin_fotos: { titulo: "Unidad sin fotos por dentro y por fuera", arreglo: "Sube las fotos exterior e interior en la ficha de la unidad.", donde: R("/vehiculos", "Vehículos") },
  unidades_titulares_insuficientes: { titulo: "Faltan unidades titulares", arreglo: "Agrega unidades titulares en Recursos.", donde: P("recursos", "unidades") },
  reten_insuficiente: { titulo: "Faltan unidades de retén", arreglo: "Agrega unidades de retén en Recursos.", donde: P("recursos", "unidades") },
  tercero_sin_autorizacion: { titulo: "La empresa tercerizada no tiene autorización vigente registrada", arreglo: "Registra la autorización de transporte y su vencimiento en la ficha de la empresa, en Tercerizadas.", donde: R("/tercerizadas", "Tercerizadas") },
  // ── Conductores
  conductor_no_existe: { titulo: "El conductor ya no existe en el ERP", arreglo: "Quítalo en Recursos o regístralo y vuelve a elegirlo.", donde: P("recursos", "conductores") },
  conductor_repetido: { titulo: "El mismo conductor está elegido dos veces", arreglo: "Quita el repetido en Recursos.", donde: P("recursos", "conductores") },
  conductor_tercerizado_prohibido: { titulo: "Conductor tercerizado en un concurso que no permite subcontratar", arreglo: "Reemplázalo en Recursos por un conductor propio, o confirma con el cliente que está permitido.", donde: P("recursos", "conductores") },
  conductor_sin_licencia: { titulo: "Conductor sin licencia registrada", arreglo: "Registra la licencia, su categoría y su vencimiento en la ficha del conductor.", donde: R("/conductores", "Conductores") },
  conductor_licencia_vencida: { titulo: "Licencia vencida a la presentación", arreglo: "Registra la licencia renovada en la ficha del conductor, o cámbialo en Recursos.", donde: R("/conductores", "Conductores") },
  conductor_licencia_vence_antes_inicio: { titulo: "La licencia vence antes del inicio del servicio", arreglo: "Prevé la renovación y regístrala en la ficha del conductor.", donde: R("/conductores", "Conductores") },
  conductor_categoria_insuficiente: { titulo: "La categoría de la licencia no alcanza", arreglo: "Elige en Recursos un conductor con la categoría exigida, o corrige la categoría en su ficha si está mal escrita.", donde: P("recursos", "conductores") },
  conductor_doc_vencido: { titulo: "Documento del conductor vencido o demasiado antiguo", arreglo: "Registra el documento renovado (con su fecha) en Documentos o en la ficha del conductor.", donde: R("/documentos", "Documentos") },
  conductor_doc_no_registrado: { titulo: "Documento del conductor sin registrar", arreglo: "Súbelo en Documentos con alcance «conductor», o escribe su vencimiento en la ficha del conductor.", donde: R("/documentos", "Documentos") },
  conductor_doc_sin_archivo: { titulo: "Documento del conductor sin archivo", arreglo: "Sube el PDF en Documentos con alcance «conductor».", donde: R("/documentos", "Documentos") },
  conductor_doc_fechas_distintas: { titulo: "La ficha y el archivo dicen vencimientos distintos", arreglo: "Corrige la fecha en la ficha del conductor o en el documento: vale la de la ficha.", donde: R("/conductores", "Conductores") },
  conductores_relevo_insuficientes: { titulo: "Faltan conductores de relevo", arreglo: "Agrega conductores de relevo en Recursos.", donde: P("recursos", "conductores") },
  // ── Legajo
  legajo_falta: { titulo: "Falta un documento del legajo", arreglo: "Súbelo en Licitaciones → Legajo de la empresa.", donde: LEGAJO },
  legajo_sin_archivo: { titulo: "Documento del legajo sin archivo", arreglo: "Sube el PDF en Licitaciones → Legajo de la empresa.", donde: LEGAJO },
  legajo_vencido: { titulo: "Documento del legajo vencido", arreglo: "Sube la versión vigente en Licitaciones → Legajo de la empresa.", donde: LEGAJO },
  legajo_antiguo: { titulo: "Documento del legajo demasiado antiguo para estas bases", arreglo: "Saca una versión reciente (SUNARP, SUNAT…) y súbela en Licitaciones → Legajo de la empresa con su fecha de emisión.", donde: LEGAJO },
  legajo_sin_fecha_emision: { titulo: "Documento del legajo sin fecha de emisión", arreglo: "Escribe la fecha de emisión en Licitaciones → Legajo de la empresa: sin ella no se puede comprobar la antigüedad.", donde: LEGAJO },
  legajo_documento_fijado_no_existe: { titulo: "El documento elegido en el expediente ya no existe", arreglo: "Elige otro documento en el ítem del Expediente (o deja «el más reciente»).", donde: P("expediente", "expediente") },
  // ── Experiencia
  experiencia_no_existe: { titulo: "Un contrato elegido ya no está en el catálogo", arreglo: "Quítalo en Recursos → Experiencia, o vuelve a registrarlo en Licitaciones → Experiencia.", donde: P("recursos", "experiencia") },
  experiencia_monto_insuficiente: { titulo: "El monto acreditado no alcanza", arreglo: "Elige más contratos en Recursos → Experiencia (o completa sus importes).", donde: P("recursos", "experiencia") },
  experiencia_anios_insuficientes: { titulo: "Los años de experiencia no alcanzan", arreglo: "Elige un contrato más antiguo en Recursos → Experiencia, o revisa la fecha de inicio en el catálogo.", donde: P("recursos", "experiencia") },
  experiencia_cartas_insuficientes: { titulo: "Faltan cartas de recomendación", arreglo: "Registra las cartas (sustento «carta» con su archivo) en Licitaciones → Experiencia y elígelas en Recursos.", donde: EXPERIENCIA },
  experiencia_fuera_de_ventana: { titulo: "Contrato fuera del periodo que piden las bases", arreglo: "Quítalo en Recursos → Experiencia o confirma que las bases lo aceptan.", donde: P("recursos", "experiencia") },
  experiencia_sin_sustento: { titulo: "Contrato sin sustento adjunto", arreglo: "Sube la OC, factura, carta o conformidad en Licitaciones → Experiencia.", donde: EXPERIENCIA },
  experiencia_sin_importe: { titulo: "Contrato sin importe", arreglo: "Escribe el importe en Licitaciones → Experiencia: en el cuadro sale «—».", donde: EXPERIENCIA },
  experiencia_moneda_mixta: { titulo: "Contratos en soles y en dólares", arreglo: "Se totalizan por separado; si las bases piden un solo total, decide cómo convertirlo y escríbelo en el texto.", donde: P("recursos", "experiencia") },
  experiencia_sin_fecha_constitucion: { titulo: "Falta la fecha de constitución de la empresa", arreglo: "Escribe la fecha de constitución en Configuración → Perfil de la empresa (requiere la migración licitaciones-04).", donde: PERFIL },
  // ── Seguros
  seguro_falta: { titulo: "Falta la póliza", arreglo: "Registra la póliza con su archivo en Seguros.", donde: R("/seguros", "Seguros") },
  seguro_vencido: { titulo: "Póliza vencida", arreglo: "Registra la póliza renovada en Seguros.", donde: R("/seguros", "Seguros") },
  seguro_vence_antes_inicio: { titulo: "La póliza vence antes del inicio del servicio", arreglo: "Prevé la renovación y regístrala en Seguros.", donde: R("/seguros", "Seguros") },
  seguro_sin_archivo: { titulo: "Póliza sin archivo", arreglo: "Sube el PDF de la póliza en Seguros.", donde: R("/seguros", "Seguros") },
  // ── Contenido
  variable_sin_resolver: { titulo: "Variable sin valor", arreglo: "Completa el dato del que sale la variable (ver el detalle) o quítala del texto en Contenido.", donde: P("contenido", "secciones") },
  marca_completar: { titulo: "Quedó una marca [COMPLETAR]", arreglo: "Escribe el texto que falta en Contenido y borra la marca.", donde: P("contenido", "secciones") },
  texto_de_otra_licitacion: { titulo: "El texto menciona otra licitación", arreglo: "Revisa el párrafo en Contenido: parece copiado de otra licitación sin limpiar.", donde: P("contenido", "secciones") },
  afirma_flota_propia: { titulo: "El texto dice «propios» y hay recursos tercerizados", arreglo: "Corrige el texto en Contenido o cambia las unidades y conductores tercerizados en Recursos.", donde: P("contenido", "secciones") },
  seccion_vacia: { titulo: "Sección activa sin contenido", arreglo: "Escribe su contenido o desactívala en Contenido.", donde: P("contenido", "secciones") },
  imagen_sin_archivo: { titulo: "Imagen sin archivo", arreglo: "Sube la imagen del bloque en Contenido o quita el bloque.", donde: P("contenido", "secciones") },
  tabla_vacia: { titulo: "Tabla sin filas", arreglo: "Completa la tabla (o los recursos de los que sale) o quítala en Contenido.", donde: P("contenido", "secciones") },
  sin_secciones: { titulo: "La propuesta no tiene secciones", arreglo: "Empieza desde la plantilla base, importa un Word o agrega secciones en Contenido.", donde: P("contenido", "secciones") },
  // ── Expediente y archivos
  expediente_bloque_vacio: { titulo: "Bloque del expediente sin documentos", arreglo: "Agrega documentos al bloque o desactívalo en Expediente.", donde: P("expediente", "expediente") },
  expediente_item_sin_archivo: { titulo: "Documento del expediente sin archivo", arreglo: "Sube el archivo del ítem en Expediente (o en su pantalla de origen).", donde: P("expediente", "expediente") },
  expediente_falta_obligatorio: { titulo: "El documento de un requisito obligatorio no está en el expediente", arreglo: "Activa su bloque y agrega el documento en Expediente.", donde: P("expediente", "expediente") },
  expediente_item_archivo_externo: { titulo: "Documento del expediente con enlace externo", arreglo: "Sube el PDF en su pantalla de origen: un enlace externo no se puede unir al expediente.", donde: P("expediente", "expediente") },
  adjunto_no_unible: { titulo: "Adjunto que no se puede unir al PDF", arreglo: "Sube el adjunto como PDF o imagen (PNG o JPG); un Word, Excel o ZIP se omite del expediente.", donde: P("expediente", "expediente") },
  expediente_pesa_mucho: { titulo: "El expediente pesa mucho", arreglo: "Comprime los PDF grandes o divide la emisión en bloques sueltos.", donde: P("expediente", "expediente") },
  pdf_protegido: { titulo: "PDF protegido con contraseña", arreglo: "Sube una versión sin protección: un PDF cifrado no se puede unir y se omite.", donde: P("expediente", "expediente") },
  pdf_ilegible: { titulo: "PDF dañado o ilegible", arreglo: "Vuelve a escanear o exportar el documento y súbelo de nuevo.", donde: P("expediente", "expediente") },
  archivo_no_descargable: { titulo: "No se pudo descargar un archivo", arreglo: "Revisa que el archivo siga en su pantalla de origen y vuelve a comprobar.", donde: P("expediente", "expediente") },
  archivo_formato_no_soportado: { titulo: "Formato de archivo no soportado", arreglo: "Sube el documento como PDF, PNG o JPG.", donde: P("expediente", "expediente") },
  archivo_demasiado_grande: { titulo: "Archivo demasiado grande", arreglo: "Comprime el PDF o la imagen y súbelo de nuevo.", donde: P("expediente", "expediente") },
  archivo_cambio_desde_emision: { titulo: "Un archivo cambió desde la última emisión", arreglo: "Es informativo: la próxima emisión llevará la versión nueva.", donde: P("revision", "hallazgos") },
};

/** Tope de las fuentes del expediente antes de avisar (R12, ~250 MB declarados, no medidos). */
export const MAX_BYTES_EXPEDIENTE = 250 * 1024 * 1024;
const RANGO_GRAVEDAD: Record<Gravedad, number> = { alarma: 0, aviso: 1, info: 2 };
const CATEGORIAS_DOCUMENTALES: readonly CategoriaRequisito[] = ["legal", "experiencia", "unidad", "conductor", "seguro", "declaracion"];

function sujetoDeLugar(l: LugarTexto): SujetoHallazgo {
  switch (l.tipo) {
    case "seccion": return { tipo: "seccion", id: l.id, rotulo: l.rotulo };
    case "bloque": return { tipo: "bloque", id: l.id, rotulo: l.rotulo };
    case "requisito": return { tipo: "requisito", id: l.id, rotulo: l.rotulo };
    case "bloque_expediente": return { tipo: "bloque_expediente", id: l.id, rotulo: l.rotulo };
    default: return { tipo: "licitacion", id: l.tipo === "glosario" || l.tipo === "consulta" ? `${l.tipo}:${l.id}` : l.tipo, rotulo: l.rotulo };
  }
}
function dondeDeLugar(l: LugarTexto): DondeSeCorrige {
  if (l.tipo === "requisito") return P("bases", `requisito:${l.id}`);
  if (l.tipo === "consulta") return P("bases", "consultas");
  if (l.tipo === "bloque_expediente") return P("expediente", `bloque_expediente:${l.id}`);
  if (l.tipo === "experiencia") return P("recursos", "experiencia");
  if (l.tipo === "bloque" || l.tipo === "seccion") return P("contenido", `${l.tipo}:${l.id}`);
  return P("contenido", l.tipo);
}

/** ¿El texto del sujeto es de una unidad o conductor? El ancla lleva al recurso. */
function dondePorSujeto(s: SujetoHallazgo): DondeSeCorrige | null {
  if (s.tipo === "requisito") return P("bases", `requisito:${s.id}`);
  if (s.tipo === "bloque" || s.tipo === "seccion") return P("contenido", `${s.tipo}:${s.id}`);
  if (s.tipo === "bloque_expediente") return P("expediente", `bloque_expediente:${s.id}`);
  if (s.tipo === "item_expediente") return P("expediente", `item:${s.id}`);
  return null;
}

/** ¿El requisito o la regla piden algo que requiere ESA fuente? (para no avisar de fuentes que no se usan). */
function fuentesDeRegla(r: Regla): FuenteContexto[] {
  switch (r.tipo) {
    case "doc_empresa": return ["legajo"];
    case "seguro": return ["seguros"];
    case "prohibe_subcontratacion": return ["unidades", "conductores"];
    case "experiencia_anios_min": return r.desde === "constitucion" ? ["experiencia", "perfil"] : ["experiencia"];
    default: return r.tipo.startsWith("experiencia") ? ["experiencia"] : r.tipo.startsWith("conductor") ? ["conductores"] : ["unidades"];
  }
}

/** Revisa la licitación. `lic.doc` tiene que venir normalizado (normalizarDoc): las claves usan sus ids. */
export function revisarLicitacion(lic: Licitacion, ctx: ContextoLicitacion, archivos?: Record<string, RevisionArchivo>, ultima?: FilaEmision | null): Revision {
  const doc = lic.doc;
  const hoy = ctx.hoy;
  const presentacion = fechaONull(lic.fecha_presentacion);
  const ref: FechaISO = presentacion ?? hoy;
  const inicio = fechaONull(lic.fecha_inicio_servicio);
  const leida = (f: FuenteContexto) => ctx.lecturas?.[f] === "ok";
  const aceptados = new Map(doc.aceptados.map((a) => [a.clave, a]));

  const lista: Hallazgo[] = [];
  const claves = new Set<string>();
  const porSujeto = new Set<string>();             // `${codigo}|${sujeto.tipo}:${sujeto.id}`
  const add = (codigo: CodigoHallazgo, sujeto: SujetoHallazgo, texto: string, o: { requisitoId?: string | null; extra?: string; donde?: DondeSeCorrige } = {}) => {
    const requisitoId = o.requisitoId ?? null;
    const clave = `${codigo}|${sujeto.tipo}:${sujeto.id}|${requisitoId ?? ""}|${o.extra ?? ""}`;
    if (claves.has(clave)) return;
    claves.add(clave);
    porSujeto.add(`${codigo}|${sujeto.tipo}:${sujeto.id}`);
    const cat = CATALOGO_HALLAZGOS[codigo];
    lista.push({
      clave, codigo, gravedad: GRAVEDAD_HALLAZGO[codigo], titulo: cat.titulo, texto, arreglo: cat.arreglo,
      donde: o.donde ?? dondePorSujeto(sujeto) ?? cat.donde, sujeto, requisitoId, aceptado: aceptados.get(clave) ?? null,
    });
  };
  const yaHay = (codigo: CodigoHallazgo, s: SujetoHallazgo) => porSujeto.has(`${codigo}|${s.tipo}:${s.id}`);
  const addSiNo = (p: ProblemaRegla) => { if (!yaHay(p.codigo, p.sujeto)) add(p.codigo, p.sujeto, p.texto, { extra: p.extra, donde: p.donde }); };
  const LIC = (rotulo: string, id = "licitacion"): SujetoHallazgo => ({ tipo: "licitacion", id, rotulo });

  // ── 1 · Fechas (k)
  if (!presentacion) add("falta_fecha_presentacion", LIC("Fecha de presentación", "fecha_presentacion"), `Sin fecha de presentación: las vigencias se miden contra hoy (${fechaDMY(hoy)}).`);
  else if (lic.estado === "preparacion" && diasISO(hoy, presentacion) < 0) add("fecha_presentacion_pasada", LIC("Fecha de presentación", "fecha_presentacion"), `La fecha de presentación (${fechaDMY(presentacion)}) ya pasó y la licitación sigue en preparación.`);
  if (!inicio) add("falta_fecha_inicio", LIC("Fecha de inicio", "fecha_inicio"), "Sin fecha de inicio del servicio: no se comprueba qué vence antes de empezar.");

  // ── 2 · Requisitos y reglas
  const evaluaciones: EvaluacionRequisito[] = [];
  const fuentesCaidas = new Set<FuenteContexto>();
  const reglasPorTipo = new Map<string, Regla[]>();
  for (const q of doc.requisitos) {
    let auto: ResultadoRegla | null = null;
    if (q.regla) {
      auto = evaluarReglaDetallada(q.regla, lic, ctx, ref);
      const arr = reglasPorTipo.get(q.regla.tipo) ?? [];
      arr.push(q.regla); reglasPorTipo.set(q.regla.tipo, arr);
      for (const f of auto.fuentesNoLeidas) fuentesCaidas.add(f);
      for (const p of auto.problemas) add(p.codigo, p.sujeto, p.texto, { requisitoId: q.id, extra: p.extra, donde: p.donde });
    }
    const suj: SujetoHallazgo = { tipo: "requisito", id: q.id, rotulo: q.numeral ? `${q.numeral} · ${q.texto.slice(0, 80)}` : q.texto.slice(0, 80) || "Requisito" };
    let final: EvaluacionRequisito["final"];
    let fuente: EvaluacionRequisito["fuente"];
    if (q.manual) {
      final = q.manual; fuente = "manual";
      if (auto && (q.manual === "cumple" || q.manual === "no_cumple") && (auto.estado === "cumple" || auto.estado === "no_cumple") && auto.estado !== q.manual)
        add("requisito_manual_contradice", suj, `Marcado «${q.manual === "cumple" ? "cumple" : "no cumple"}» a mano, pero el ERP comprueba que ${auto.estado === "cumple" ? "sí cumple" : "no cumple"}: ${auto.detalle}`, { requisitoId: q.id });
    } else if (auto) { final = auto.estado; fuente = "regla"; }
    else { final = "pendiente"; fuente = "ninguna"; }
    evaluaciones.push({ requisitoId: q.id, auto: auto ? { estado: auto.estado, codigos: auto.codigos, detalle: auto.detalle, sustento: auto.sustento } : null, final, fuente });

    if (!q.regla && q.manual === "no_cumple") add("requisito_no_cumple", suj, `«${q.texto.slice(0, 120)}» está marcado «no cumple».`, { requisitoId: q.id });
    if (q.obligatorio && (final === "pendiente" || final === "no_se_puede_juzgar"))
      add("requisito_obligatorio_pendiente", suj, final === "pendiente" ? "Obligatorio y sin marcar." : `Obligatorio y no se puede comprobar: ${auto?.detalle ?? ""}`.trim(), { requisitoId: q.id });
    else if (!q.obligatorio && final === "no_se_puede_juzgar") add("requisito_no_juzgable", suj, auto?.detalle ?? "No se puede comprobar.", { requisitoId: q.id });
    if (q.enMatriz && final === "cumple" && !q.sustento.trim() && !auto?.sustento) add("requisito_sin_sustento", suj, "Cumple, pero la columna «Sustento adjunto» de la matriz quedaría vacía.", { requisitoId: q.id });
    if (final !== "no_aplica") {
      if (q.bloqueExpedienteId) {
        const b = doc.expediente.bloques.find((x) => x.id === q.bloqueExpedienteId);
        if (!b || !b.activo || !b.items.some((i) => i.incluido)) {
          const que = !b ? "un bloque que ya no existe" : !b.activo ? `el bloque «${b.titulo || b.subtitulo}», que está desactivado` : `el bloque «${b.titulo || b.subtitulo}», que no tiene documentos`;
          add(q.obligatorio ? "expediente_falta_obligatorio" : "requisito_sin_documento_en_expediente", suj, `Su documento va en ${que}.`, { requisitoId: q.id });
        }
      } else if (q.obligatorio && CATEGORIAS_DOCUMENTALES.includes(q.categoria)) {
        add("requisito_sin_documento_en_expediente", suj, "No tiene bloque del expediente elegido para su documento.", { requisitoId: q.id });
      }
    }
  }

  // ── 3 · Fuentes caídas (a): UNA por fuente, solo si la licitación la usa
  const exp = doc.expediente;
  const itemsIncluidos = exp.bloques.filter((b) => b.activo).flatMap((b) => b.items.filter((i) => i.incluido).map((i) => ({ b, i })));
  const usaAuto = (a: string) => doc.secciones.some((s) => s.activa && s.bloques.some((b) => b.tipo === "auto" && b.auto === a));
  const usa: Record<FuenteContexto, boolean> = {
    perfil: true,
    unidades: doc.unidades.length > 0,
    conductores: doc.conductores.length > 0,
    legajo: itemsIncluidos.some(({ i }) => i.fuente.tipo === "legajo"),
    experiencia: doc.experiencia.ids.length > 0 || usaAuto("cuadro_experiencia"),
    seguros: itemsIncluidos.some(({ i }) => i.fuente.tipo === "seguro"),
    personal: doc.representante.personalId != null || doc.contactos.some((c) => c.personalId != null),
    otras: true,
  };
  for (const q of doc.requisitos) if (q.regla) for (const f of fuentesDeRegla(q.regla)) usa[f] = true;
  for (const f of Object.keys(usa) as FuenteContexto[]) {
    if ((usa[f] && !leida(f)) || fuentesCaidas.has(f)) {
      const est = ctx.lecturas?.[f];
      add("fuente_no_leida", LIC(NOMBRE_FUENTE[f], `fuente:${f}`), `No se pudo leer ${NOMBRE_FUENTE[f]}${est === "sin_tabla" ? " (falta su migración)" : ""}: no se afirma que falte nada de esa fuente.`, { extra: f });
    }
  }

  // ── 4 · Perfil, autorización y representante
  const perfil = ctx.perfil;
  if (leida("perfil")) {
    const emp = empresaConDefectos(perfil);
    const faltan = [...(emp.sinConfigurar ? ["Nombre de la empresa"] : []), ...emp.faltan.filter((x) => !(emp.sinConfigurar && x === "Nombre de la empresa"))];
    if (!perfil || faltan.length) add("perfil_incompleto", LIC("Perfil de la empresa", "perfil"), `Falta en el perfil: ${faltan.join(", ") || "todo"}.`);
  }
  const rep = representanteDe(doc, ctx);
  if (!(doc.representante.personalId != null && !leida("personal"))) {
    const faltan = [!rep.nombre && "nombre", !rep.dni && "DNI", !rep.cargo && "cargo"].filter(Boolean);
    if (rep.personalNoEncontrado) add("representante_incompleto", LIC("Representante legal", "representante"), "La persona elegida como representante ya no está en el personal administrativo.");
    else if (faltan.length) add("representante_incompleto", LIC("Representante legal", "representante"), `Falta ${faltan.join(", ")} del representante legal.`);
  }
  const necesitaFirma = (doc.carta.activa && doc.carta.conFirma) || (doc.cierre.activo && doc.cierre.conFirma) || itemsIncluidos.some(({ i }) => i.fuente.tipo === "cuadro_experiencia");
  if (necesitaFirma && !doc.representante.firma) add("firma_falta", LIC("Firma del representante", "firma"), "La carta, el cierre o el cuadro de experiencia van firmados y no hay imagen de la firma.");

  // ── 5 · Unidades (genérico, una vez por unidad)
  const refs = { presentacion: ref, inicio };
  if (leida("unidades")) {
    const vistas = new Map<string, number>(), codigos = new Map<string, number>();
    for (const el of doc.unidades) {
      const u = ctx.unidades?.[el.clave];
      const suj = sujetoUnidad(el, u);
      const veces = (vistas.get(el.clave) ?? 0) + 1; vistas.set(el.clave, veces);
      if (veces === 2) add("unidad_repetida", suj, `${u?.placa ?? el.clave} está elegida más de una vez.`);
      const cod = el.codigo.trim().toUpperCase();
      if (cod) { const k = (codigos.get(cod) ?? 0) + 1; codigos.set(cod, k); if (k === 2) add("unidad_codigo_repetido", { tipo: "licitacion", id: `codigo:${cod}`, rotulo: `Código ${el.codigo}` }, `Hay más de una unidad con el código ${el.codigo}.`, { donde: P("recursos", "unidades") }); }
      if (!u) { add("unidad_no_existe", suj, `${el.codigo || "Una unidad"} apunta a una unidad que ya no está en la flota del ERP (${el.clave}).`); continue; }
      if (veces > 1) continue;
      const r = resumenUnidad(u, refs);
      if (!r.activa) add("unidad_inactiva", suj, `${u.placa} figura como «${u.estado}».`);
      if (!u.anio) add("unidad_sin_anio", suj, u.flota === "t" && ctx.migraciones?.anioTercero === false
        ? `${u.placa} es de un tercero y su ficha todavía no guarda el año (falta la migración licitaciones-04): la antigüedad no se puede comprobar.`
        : `${u.placa} no tiene año de fabricación: la antigüedad no se puede comprobar.`);
      if (!u.capacidad) add("unidad_sin_capacidad", suj, `${u.placa} no tiene capacidad registrada.`, { donde: u.flota === "t" ? R("/tercerizadas", "Tercerizadas") : R("/vehiculos", "Vehículos") });
      else if (el.capacidadExigida && u.capacidad < el.capacidadExigida) add("unidad_capacidad_insuficiente", suj, `${u.placa} tiene ${u.capacidad} asientos; para «${el.uso || el.codigo}» se exigen ${el.capacidadExigida}.`, { extra: `exigida:${el.capacidadExigida}` });
      if (r.empresa && r.empresa.autorizacion !== "vigente") add("tercero_sin_autorizacion", { tipo: "licitacion", id: `empresa:${u.empresa?.id ?? 0}`, rotulo: r.empresa.razonSocial }, `${r.empresa.razonSocial} ${r.empresa.autorizacion === "vencida" ? "tiene la autorización vencida" : "no tiene autorización registrada"}.`);
    }
  }

  // ── 6 · Conductores (genérico)
  if (leida("conductores")) {
    const vistos = new Map<string, number>();
    for (const el of doc.conductores) {
      const c = ctx.conductores?.[el.clave];
      const suj = sujetoConductor(el, c);
      const veces = (vistos.get(el.clave) ?? 0) + 1; vistos.set(el.clave, veces);
      if (veces === 2) add("conductor_repetido", suj, `${c?.nombre ?? el.clave} está elegido más de una vez.`);
      if (!c) { add("conductor_no_existe", suj, `Un conductor elegido ya no está en el ERP (${el.clave}).`); continue; }
      if (veces > 1) continue;
      const donde = c.flota === "t" ? R("/tercerizadas", "Tercerizadas") : R("/conductores", "Conductores");
      const sinLic = !c.licencia?.trim() && !c.categoria_licencia?.trim();
      if (sinLic) { if (!yaHay("conductor_sin_licencia", suj)) add("conductor_sin_licencia", suj, `${c.nombre} no tiene licencia registrada.`, { donde }); continue; }
      const venc = fechaONull(c.vencimiento_licencia);
      if (venc && vigencia(venc, ref).estado === "vencido") { if (!yaHay("conductor_licencia_vencida", suj)) add("conductor_licencia_vencida", suj, `La licencia de ${c.nombre} venció el ${fechaDMY(venc)}.`, { donde }); }
      else if (venc && inicio && vigencia(venc, inicio).estado === "vencido" && !yaHay("conductor_licencia_vence_antes_inicio", suj))
        add("conductor_licencia_vence_antes_inicio", suj, `La licencia de ${c.nombre} vence el ${fechaDMY(venc)}, antes del inicio del servicio.`, { donde });
    }
  }

  // ── 7 · Lo que el EXPEDIENTE incluye sin que una regla lo pida (d)
  const reglaCubre = (tipo: string, pred: (r: Regla) => boolean) => (reglasPorTipo.get(tipo) ?? []).some(pred);
  for (const { b, i } of itemsIncluidos) {
    const f = i.fuente;
    const sujItem: SujetoHallazgo = { tipo: "item_expediente", id: i.id, rotulo: i.titulo ?? `${b.titulo || b.subtitulo} · documento` };
    if (f.tipo === "docs_unidades" && leida("unidades") && !reglaCubre("unidad_doc", (r) => r.tipo === "unidad_doc" && r.doc === f.doc)) {
      const sub = { ...lic, doc: { ...doc, unidades: doc.unidades.filter((u) => f.roles.includes(u.rol)) } };
      for (const p of evaluarReglaDetallada({ tipo: "unidad_doc", doc: f.doc, vigenteAl: "presentacion" }, sub, ctx, ref).problemas) addSiNo(p);
    }
    if (f.tipo === "fotos_unidades" && leida("unidades") && !reglasPorTipo.has("unidad_fotos")) {
      const sub = { ...lic, doc: { ...doc, unidades: doc.unidades.filter((u) => f.roles.includes(u.rol)) } };
      for (const p of evaluarReglaDetallada({ tipo: "unidad_fotos" }, sub, ctx, ref).problemas) addSiNo(p);
    }
    if (f.tipo === "docs_conductores" && leida("conductores")) {
      const sub = { ...lic, doc: { ...doc, conductores: doc.conductores.filter((c) => f.roles.includes(c.rol)) } };
      if (f.doc === "licencia_conducir" || f.doc === "capacitacion") {
        for (const el of sub.doc.conductores) {
          const c = ctx.conductores?.[el.clave];
          if (!c) continue;
          const suj = sujetoConductor(el, c);
          const fila = documentoVigente(f.doc, archivosConductor(c, f.doc), null);
          const nombre = tipoDocConductor(f.doc).etiqueta.toLowerCase();
          if (!fila) { if (!(c.flota === "t" && ctx.migraciones?.conductorTercero === false)) addSiNo({ codigo: "conductor_doc_no_registrado", sujeto: suj, texto: `${c.nombre} no tiene archivo de ${nombre}.`, extra: f.doc }); }
          else if (origenArchivo(fila.archivo_url, null) === "vacio") addSiNo({ codigo: "conductor_doc_sin_archivo", sujeto: suj, texto: `El documento de ${nombre} de ${c.nombre} no tiene archivo.`, extra: f.doc });
        }
      } else if (!reglaCubre("conductor_doc", (r) => r.tipo === "conductor_doc" && r.doc === f.doc)) {
        for (const p of evaluarReglaDetallada({ tipo: "conductor_doc", doc: f.doc, antiguedadMaxDias: null }, sub, ctx, ref).problemas) addSiNo(p);
      }
    }
    if (f.tipo === "seguro" && leida("seguros") && !reglaCubre("seguro", (r) => r.tipo === "seguro" && r.seguro === f.seguro)) {
      for (const p of evaluarReglaDetallada({ tipo: "seguro", seguro: f.seguro, vigenteAl: "presentacion" }, lic, ctx, ref).problemas) addSiNo(p);
    }
    if (f.tipo === "legajo" && leida("legajo")) {
      if (f.documentoId != null && !fijadoExiste(f.codigo, ctx.legajo ?? [], f.documentoId))
        add("legajo_documento_fijado_no_existe", sujItem, `El documento elegido para «${tipoLegajo(f.codigo).etiqueta}» ya no está en el legajo; se usará el más reciente.`);
      if (!reglaCubre("doc_empresa", (r) => r.tipo === "doc_empresa" && r.legajo === f.codigo)) {
        const est = estadoLegajo(f.codigo, ctx.legajo ?? [], ref, null, f.documentoId);
        const suj: SujetoHallazgo = { tipo: "legajo", id: f.codigo, rotulo: tipoLegajo(f.codigo).etiqueta };
        const et = tipoLegajo(f.codigo).etiqueta;
        if (est.estado === "falta") addSiNo({ codigo: "legajo_falta", sujeto: suj, texto: `El expediente incluye «${et}» y no está en el legajo.`, extra: "" });
        else if (est.estado === "vencido") addSiNo({ codigo: "legajo_vencido", sujeto: suj, texto: `${et} venció el ${fechaDMY(est.fila?.fecha_vencimiento)}.`, extra: "" });
        else if (est.estado === "sin_archivo") addSiNo({ codigo: "legajo_sin_archivo", sujeto: suj, texto: `${et} está registrado sin archivo.`, extra: "" });
      }
    }
    if (f.tipo === "adjunto") {
      if (!f.archivo) add("expediente_item_sin_archivo", sujItem, `«${i.titulo ?? "Adjunto"}» está pendiente de subir.`);
      else if (!["application/pdf", "image/png", "image/jpeg"].includes(f.archivo.mime)) add("adjunto_no_unible", sujItem, `«${f.archivo.nombre}» no es PDF ni imagen: se omitirá del expediente unido.`);
    }
  }
  for (const b of exp.bloques) if (b.activo && !b.items.some((i) => i.incluido)) add("expediente_bloque_vacio", { tipo: "bloque_expediente", id: b.id, rotulo: b.titulo || b.subtitulo || "Bloque" }, `«${[b.titulo, b.subtitulo].filter(Boolean).join(" · ") || "Bloque"}» está activo y no tiene documentos.`);

  // ── 8 · Experiencia (genérico; e: por moneda)
  if (leida("experiencia")) {
    const usaCuadro = usaAuto("cuadro_experiencia") || itemsIncluidos.some(({ i }) => i.fuente.tipo === "cuadro_experiencia");
    const sustentos = itemsIncluidos.map(({ i }) => i.fuente).filter((f) => f.tipo === "sustentos_experiencia");
    for (const id of doc.experiencia.ids) {
      const e = ctx.experiencia?.[id];
      const suj: SujetoHallazgo = { tipo: "experiencia", id: String(id), rotulo: e?.cliente_nombre ?? `Contrato #${id}` };
      if (!e) { add("experiencia_no_existe", suj, `El contrato #${id} ya no está en el catálogo de experiencia.`); continue; }
      if (usaCuadro && e.importe == null) addSiNo({ codigo: "experiencia_sin_importe", sujeto: suj, texto: `${e.cliente_nombre} no tiene importe: en el cuadro sale «—».`, extra: "" });
      if (sustentos.length && !(e.sustentos ?? []).length) addSiNo({ codigo: "experiencia_sin_sustento", sujeto: suj, texto: `${e.cliente_nombre} no tiene archivo de sustento.`, extra: "" });
      if (doc.experiencia.ventanaAnios && !reglasPorTipo.has("experiencia_ventana_anios")) {
        for (const p of evaluarReglaDetallada({ tipo: "experiencia_ventana_anios", anios: doc.experiencia.ventanaAnios }, { ...lic, doc: { ...doc, experiencia: { ...doc.experiencia, ids: [id] } } }, ctx, ref).problemas) addSiNo(p);
      }
    }
    if (totalesExperiencia(doc, ctx).length > 1) addSiNo({ codigo: "experiencia_moneda_mixta", sujeto: LIC("Experiencia"), texto: "La experiencia elegida tiene contratos en soles y en dólares: se totaliza por moneda, sin sumarlas.", extra: "" });
  }

  // ── 9 · Contenido (f, g, h)
  const activas = doc.secciones.filter((s) => s.activa);
  if (!activas.length) add("sin_secciones", LIC("Contenido", "contenido"), "La propuesta no tiene ninguna sección activa.");
  for (const s of activas) {
    const rot = s.titulo || "Sección sin título";
    if (!s.bloques.some((b) => b.tipo !== "salto_pagina")) add("seccion_vacia", { tipo: "seccion", id: s.id, rotulo: rot }, `«${rot}» está activa y no tiene contenido.`);
    for (const b of s.bloques) {
      const suj: SujetoHallazgo = { tipo: "bloque", id: b.id, rotulo: `${rot} · ${b.tipo}` };
      if (b.tipo === "imagen" && !b.archivo) add("imagen_sin_archivo", suj, `Una imagen de «${rot}» no tiene archivo.`);
      if (b.tipo === "tabla" && !b.filas.length) add("tabla_vacia", suj, `Una tabla de «${rot}» no tiene filas.`);
      if (b.tipo === "auto" && !b.filasExtra.length && autoVacio(b.auto, lic)) add("tabla_vacia", suj, `La tabla automática de «${rot}» saldrá sin filas (no hay datos de los que armarla).`);
    }
  }
  const esc = escanearTexto(lic, ctx);
  for (const m of esc.completar) add("marca_completar", sujetoDeLugar(m.lugar), `«${m.lugar.rotulo}» tiene ${m.veces === 1 ? "una marca" : `${m.veces} marcas`} [COMPLETAR].`, { donde: dondeDeLugar(m.lugar) });
  for (const m of esc.variables) add("variable_sin_resolver", sujetoDeLugar(m.lugar), m.conocida ? `{${m.nombre}} no tiene valor en «${m.lugar.rotulo}».` : `{${m.nombre}} no es una variable conocida («${m.lugar.rotulo}»).`, { extra: m.nombre, donde: dondeDeLugar(m.lugar) });
  if (leida("otras") || doc.copiaDe) for (const m of esc.otraLicitacion) add("texto_de_otra_licitacion", sujetoDeLugar(m.lugar), `«${m.lugar.rotulo}» menciona «${m.mencion}», de ${m.deQuien}.`, { extra: m.mencion, donde: dondeDeLugar(m.lugar) });
  const hayTerceros = doc.unidades.some((u) => u.clave.startsWith("t:")) || doc.conductores.some((c) => c.clave.startsWith("t:"));
  if (hayTerceros) for (const m of esc.flotaPropia) add("afirma_flota_propia", sujetoDeLugar(m.lugar), `«${m.lugar.rotulo}» dice «${m.frase}» y hay unidades o conductores tercerizados elegidos.`, { donde: dondeDeLugar(m.lugar) });
  if (leida("perfil")) {
    const delPerfil = autorizacionDelPerfil(perfil?.autorizacion_mtc);
    if (!delPerfil) { if (esc.autorizaciones.length || usaAuto("datos_postor")) add("autorizacion_sin_perfil", LIC("Autorización de transporte", "autorizacion"), esc.autorizaciones.length ? `El texto cita la autorización ${esc.autorizaciones[0].token} y el perfil no tiene ninguna con la que cotejarla.` : "Los datos del postor saldrán sin autorización."); }
    else for (const m of esc.autorizaciones) if (!mismaAutorizacion(m.token, delPerfil))
      add("autorizacion_mtc_distinta", sujetoDeLugar(m.lugar), `«${m.lugar.rotulo}» cita la R.D. ${m.token} y el perfil de la empresa dice ${delPerfil}. Revisa cuál es la vigente.`, { extra: m.token, donde: dondeDeLugar(m.lugar) });
  }

  // ── 10 · Archivos comprobados (dry run o emisión) y cambios desde la última emisión
  const fechaReferencia = ref;
  const parcial: Revision = { hallazgos: [], evaluaciones, cuenta: { alarma: 0, aviso: 0, info: 0 }, fechaReferencia, referenciaEs: presentacion ? "presentacion" : "hoy" };
  const exr = resolverExpediente(lic, ctx, parcial);
  // Lo que el expediente omite por no tener archivo unible y que ningún control de arriba nombró ya
  // (un documento del legajo o una póliza con enlace de Drive, un sustento en Word).
  const FALTANTES_PROPIOS: CodigoHallazgo[] = ["expediente_item_archivo_externo", "expediente_item_sin_archivo", "adjunto_no_unible"];
  for (const b of exr.bloques) for (const p of b.partes) {
    if (p.tipo !== "faltante" || !FALTANTES_PROPIOS.includes(p.codigo)) continue;
    const suj: SujetoHallazgo = { tipo: "item_expediente", id: p.itemId, rotulo: p.titulo };
    if (yaHay(p.codigo, suj)) continue;
    add(p.codigo, suj, p.codigo === "expediente_item_archivo_externo"
      ? `«${p.titulo}» es un enlace externo: se omitirá del expediente unido.`
      : p.codigo === "adjunto_no_unible" ? `«${p.titulo}» no es PDF ni imagen: se omitirá del expediente unido.` : `«${p.titulo}» está pendiente de subir.`);
  }
  const partes = exr.bloques.flatMap((b) => b.partes.filter((p) => p.tipo === "archivo").map((p) => ({ b, p: p as Extract<typeof p, { tipo: "archivo" }> })));
  let bytes = 0;
  const vistosUrl = new Set<string>();
  for (const { p } of partes) {
    if (vistosUrl.has(p.url)) continue;
    vistosUrl.add(p.url);
    const ra = archivos?.[p.url];
    const sujA: SujetoHallazgo = { tipo: "archivo", id: p.url, rotulo: p.titulo };
    if (p.origen === "externo" && !(ra && !ra.ok)) addSiNo({ codigo: "expediente_item_archivo_externo", sujeto: sujA, texto: `«${p.titulo}» es un enlace externo: no se puede unir al expediente.`, extra: "" });
    if (!ra) continue;
    if (ra.ok) {
      bytes += ra.bytes;
      const antes = ultima?.foto?.fuentes?.find((x) => x.url === p.url);
      if (antes?.sha256 && ra.sha256 && antes.sha256 !== ra.sha256) add("archivo_cambio_desde_emision", sujA, `«${p.titulo}» cambió desde la emisión versión ${ultima?.version}.`);
    } else {
      add(ra.codigo === "archivo_externo" ? "expediente_item_archivo_externo" : ra.codigo, sujA, `«${p.titulo}»: ${ra.detalle}`);
    }
  }
  for (const { i } of itemsIncluidos) if (i.fuente.tipo === "adjunto" && i.fuente.archivo && !archivos?.[i.fuente.archivo.url]) bytes += i.fuente.archivo.bytes;
  if (bytes > MAX_BYTES_EXPEDIENTE) add("expediente_pesa_mucho", LIC("Expediente", "expediente"), `Las fuentes del expediente suman ${Math.round(bytes / 1024 / 1024)} MB (tope declarado ${Math.round(MAX_BYTES_EXPEDIENTE / 1024 / 1024)} MB).`);

  // ── Cierre: gravedad, luego el orden de los pasos, luego el de aparición
  const pasoDe = (h: Hallazgo) => ("paso" in h.donde ? PASOS.indexOf(h.donde.paso) : PASOS.length);
  const orden = lista.map((h, k) => ({ h, k })).sort((a, b) => RANGO_GRAVEDAD[a.h.gravedad] - RANGO_GRAVEDAD[b.h.gravedad] || pasoDe(a.h) - pasoDe(b.h) || a.k - b.k).map((x) => x.h);
  const cuenta: Record<Gravedad, number> = { alarma: 0, aviso: 0, info: 0 };
  for (const h of orden) if (!h.aceptado) cuenta[h.gravedad]++;
  return { hallazgos: orden, evaluaciones, cuenta, fechaReferencia, referenciaEs: presentacion ? "presentacion" : "hoy" };
}

/** ¿La tabla automática saldría sin filas? (los datos de los que se arma están vacíos). */
function autoVacio(auto: string, lic: Licitacion): boolean {
  const d = lic.doc;
  switch (auto) {
    case "relacion_unidades": return !d.unidades.length;
    case "conductores": return !d.conductores.length;
    case "matriz_cumplimiento": return !d.requisitos.some((q) => q.enMatriz);
    case "absolucion_consultas": return !d.consultas.length;
    case "cuadro_experiencia": return !d.experiencia.ids.length;
    case "contactos": return !d.contactos.length;
    case "relacion_adjuntos": return !d.expediente.bloques.some((b) => b.activo);
    case "exigido_ofertado": return !d.requisitos.some((q) => q.regla && /^(unidad|unidades|conductor|conductores)_/.test(q.regla.tipo));
    default: return false;
  }
}
