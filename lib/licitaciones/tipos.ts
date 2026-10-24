// lib/licitaciones/tipos.ts — CONTRATO del módulo Licitaciones. SOLO tipos y constantes (PURO:
// navegador, servidor y matrices). Un cambio aquí es un cambio de contrato entre agentes.
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import type { FilaSeguro } from "@/lib/seguros";

// ══ Identidades ═══════════════════════════════════════════════════════════════
export type FechaISO = string;      // "YYYY-MM-DD", calendario de Lima (fechaLima de lib/documentos-estado)
export type InstanteISO = string;   // ISO 8601 con zona
export type Flota = "p" | "t";      // p = vehiculos/conductores · t = vehiculos_tercero/conductores_tercero
/** MISMO formato que claveUnidad/claveConductor (lib/flota/excesos.ts). Los ids se solapan: la clave lleva la tabla. */
export type ClaveRecurso = `${Flota}:${number}`;
export type Paso = "bases" | "recursos" | "contenido" | "expediente" | "revision";
export const PASOS: readonly Paso[] = ["bases", "recursos", "contenido", "expediente", "revision"];
export const ESQUEMA_DOC = 1 as const;
export type Moneda = "PEN" | "USD";
export type Gravedad = "alarma" | "aviso" | "info";

// ══ Archivos ══════════════════════════════════════════════════════════════════
export const BUCKET_LICITACIONES = "licitaciones" as const;
export type CarpetaLicitacion = "bases" | "adjuntos" | "imagenes" | "firmas" | "experiencia" | "emisiones";
export const CARPETAS_LICITACION: readonly CarpetaLicitacion[] = ["bases", "adjuntos", "imagenes", "firmas", "experiencia", "emisiones"];
export type MimeArchivo =
  | "application/pdf" | "image/png" | "image/jpeg" | "application/zip"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.ms-excel";
/** `url` es el IDENTIFICADOR (enlace público de Storage, como el resto del ERP): se firma al usarlo y NUNCA
 *  se guarda un firmado. La ruta se DERIVA con objetoPrivadoDe(url): no se guarda aparte. */
export type ArchivoRef = {
  id: string;                 // uuid del navegador, estable dentro del doc
  url: string;
  nombre: string;             // nombre original (≤ 200)
  mime: MimeArchivo;
  bytes: number;
  sha256: string | null;      // hex; null si no hubo crypto.subtle
  paginas: number | null;     // solo PDF
  subidoEn: InstanteISO;
};
export type TipoBase = "bases" | "tdr" | "absolucion" | "anexo" | "requisitos_cliente" | "otro";
export type ArchivoBase = ArchivoRef & { tipo: TipoBase };
/** ¿Se puede UNIR al expediente? Solo storage_privado/storage_publico de ESTE proyecto. */
export type OrigenArchivo = "vacio" | "storage_privado" | "storage_publico" | "externo";

// ══ Catálogos cerrados ════════════════════════════════════════════════════════
export type CategoriaRequisito =
  | "legal" | "experiencia" | "unidad" | "conductor" | "seguro" | "declaracion" | "tecnico" | "economico" | "otro";
export const CATEGORIAS_REQUISITO: readonly CategoriaRequisito[] =
  ["legal", "experiencia", "unidad", "conductor", "seguro", "declaracion", "tecnico", "economico", "otro"];

/** Legajo de la empresa = documentos_empresa (alcance 'empresa', categoria = código). Pólizas NO (viven en `seguros`). */
export type CodigoLegajo =
  | "ficha_ruc" | "copia_literal" | "vigencia_poder" | "dni_representante" | "autorizacion_transporte"
  | "constancia_rnp" | "certificado_inscripcion" | "brochure" | "plan_sst" | "programa_sst" | "plan_emergencias"
  | "iperc" | "rit" | "politica_alcohol_drogas" | "organigrama" | "estados_financieros" | "certificacion" | "otro_legajo";
export const CODIGOS_LEGAJO: readonly CodigoLegajo[] = [
  "ficha_ruc", "copia_literal", "vigencia_poder", "dni_representante", "autorizacion_transporte", "constancia_rnp",
  "certificado_inscripcion", "brochure", "plan_sst", "programa_sst", "plan_emergencias", "iperc", "rit",
  "politica_alcohol_drogas", "organigrama", "estados_financieros", "certificacion", "otro_legajo"];
/** Documentos del conductor = documentos_empresa (alcance 'conductor', conductor_id | conductor_tercero_id).
 *  "capacitacion" es la categoría que /documentos YA usa. */
export type CodigoDocConductor =
  | "licencia_conducir" | "record_conductor" | "antecedentes_penales" | "antecedentes_policiales"
  | "examen_medico" | "psicosometrico" | "capacitacion";
export const CODIGOS_DOC_CONDUCTOR: readonly CodigoDocConductor[] = [
  "licencia_conducir", "record_conductor", "antecedentes_penales", "antecedentes_policiales",
  "examen_medico", "psicosometrico", "capacitacion"];

export type DocUnidadLic = "soat" | "citv" | "tarjeta_propiedad" | "tuc" | "habilitacion";
export const DOCS_UNIDAD_LIC: readonly DocUnidadLic[] = ["soat", "citv", "tarjeta_propiedad", "tuc", "habilitacion"];
/** Tipos CANÓNICOS de lib/documentos-estado.ts (TIPOS_DOC_UNIDAD) que cumplen cada exigencia: la misma
 *  identidad con que se ESCRIBEN las filas. La matriz exige que cada uno exista allí. */
export const CANONICOS_DOC_UNIDAD: Record<DocUnidadLic, readonly string[]> = {
  soat: ["SOAT", "CAT"],
  citv: ["Revisión Técnica (CITV)"],
  tarjeta_propiedad: ["Tarjeta de Propiedad"],
  tuc: ["Tarjeta Única de Circulación (TUC)"],
  habilitacion: ["Habilitación Vehicular (MTC/ATU)"],
};
export type CategoriaLicencia = "A-I" | "A-IIa" | "A-IIb" | "A-IIIa" | "A-IIIb" | "A-IIIc";
/** Claves de TIPOS_SEGURO (lib/seguros.ts). */
export type TipoSeguroLic = "responsabilidad_civil" | "deshonestidad" | "todo_riesgo" | "sctr_salud" | "sctr_pension" | "vida_ley";
export type SustentoTipo = "oc" | "factura" | "carta" | "contrato" | "conformidad" | "otro";
export type FechaReferencia = "presentacion" | "inicio_servicio";

// ══ Reglas verificables (catálogo CERRADO: la IA solo puede proponer estas) ════════
export type Regla =
  | { tipo: "doc_empresa"; legajo: CodigoLegajo; antiguedadMaxDias: number | null }
  | { tipo: "unidad_antiguedad_max"; anios: number; referencia: FechaReferencia }
  | { tipo: "unidad_capacidad_min"; asientos: number; uso: string | null }          // uso null = todas
  | { tipo: "unidad_doc"; doc: DocUnidadLic; vigenteAl: FechaReferencia }
  | { tipo: "unidad_fotos" }
  | { tipo: "unidades_titulares_min"; n: number }
  | { tipo: "unidades_reten_min"; n: number }
  | { tipo: "conductor_licencia"; categorias: CategoriaLicencia[] }                  // cualquiera que CUBRA una de ellas
  | { tipo: "conductor_doc"; doc: Exclude<CodigoDocConductor, "licencia_conducir" | "capacitacion">; antiguedadMaxDias: number | null }
  | { tipo: "conductores_relevo_min"; n: number }
  | { tipo: "prohibe_subcontratacion" }
  | { tipo: "experiencia_anios_min"; anios: number; desde: "primer_contrato" | "constitucion" }
  | { tipo: "experiencia_monto_min"; monto: number; moneda: Moneda }
  | { tipo: "experiencia_cartas_min"; n: number }
  | { tipo: "experiencia_ventana_anios"; anios: number }
  | { tipo: "seguro"; seguro: TipoSeguroLic; vigenteAl: FechaReferencia };
export type TipoRegla = Regla["tipo"];
export const TIPOS_REGLA: readonly TipoRegla[] = [
  "doc_empresa", "unidad_antiguedad_max", "unidad_capacidad_min", "unidad_doc", "unidad_fotos",
  "unidades_titulares_min", "unidades_reten_min", "conductor_licencia", "conductor_doc", "conductores_relevo_min",
  "prohibe_subcontratacion", "experiencia_anios_min", "experiencia_monto_min", "experiencia_cartas_min",
  "experiencia_ventana_anios", "seguro"];

// ══ Paso 1 · Bases y requisitos ═════════════════════════════════════════════════
export type CitaBases = { archivoId: string | null; pagina: number | null; texto: string | null };
export type EstadoManual = "cumple" | "no_cumple" | "no_aplica";
export type Requisito = {
  id: string;
  numeral: string | null;              // "5.2", "Sección IV", "Pregunta 5"
  texto: string;                       // ≤ 1000
  categoria: CategoriaRequisito;
  obligatorio: boolean;
  regla: Regla | null;                 // null = se juzga a mano
  manual: EstadoManual | null;         // null = decide la regla (o queda pendiente)
  cumpleTexto: string | null;          // columna «Cumple» si no basta «Sí»: "Sí (9+ años)"
  sustento: string;                    // columna «Sustento adjunto» de la matriz
  bloqueExpedienteId: string | null;
  enMatriz: boolean;
  origen: "manual" | "ia" | "plantilla" | "copia";
  cita: CitaBases | null;
};
export type ConsultaAbsuelta = {
  id: string; numero: string | null; pregunta: string; respuesta: string;
  incorporacion: string;               // «Cómo la incorpora el postor»
  cita: CitaBases | null;
};

// ══ Paso 2 · Recursos ═══════════════════════════════════════════════════════════
export type RolUnidad = "titular" | "reten";
export type RolConductor = "titular" | "relevo";
export type UnidadElegida = { id: string; clave: ClaveRecurso; codigo: string; rol: RolUnidad; uso: string; capacidadExigida: number | null };
export type ConductorElegido = { id: string; clave: ClaveRecurso; rol: RolConductor; unidadCodigo: string | null };
export type SeleccionExperiencia = { ids: number[]; ventanaAnios: number | null; conContacto: boolean; introduccion: string };
/** Con personalId, nombre/cargo/telefono/email van VACÍOS y se DERIVAN de personal_administrativo. */
export type Contacto = { id: string; rol: string; personalId: number | null; nombre: string; cargo: string; telefono: string; email: string; emergencia: boolean };
/** Con personalId, nombre/dni/cargo van VACÍOS y se DERIVAN. Nunca va a empresa_perfil (legible por anon). */
export type Representante = { personalId: number | null; nombre: string; dni: string; cargo: string; firma: ArchivoRef | null };

// ══ Paso 3 · Contenido ══════════════════════════════════════════════════════════
export type Portada = { modo: "generada" | "imagen"; imagen: ArchivoRef | null; titulo: string; subtitulo: string; cabecera: string; color: string /* #RRGGBB */ };
export type ControlDocumento = { activo: boolean; documento: string; version: string; codigo: string; elaboradoPor: string; revisadoPor: string; aprobadoPor: string; fecha: FechaISO | null; confidencialidad: string };
export type Carta = { activa: boolean; lugarFecha: string; destinatario: string; atencion: string; referencia: string; cuerpo: string; despedida: string; conFirma: boolean };
export type EntradaGlosario = { id: string; termino: string; definicion: string };
export type Cierre = { activo: boolean; texto: string; conFirma: boolean };
export type TipoAuto =
  | "datos_postor" | "relacion_unidades" | "exigido_ofertado" | "conductores" | "matriz_cumplimiento"
  | "absolucion_consultas" | "cuadro_experiencia" | "contactos" | "relacion_adjuntos";
export const TIPOS_AUTO: readonly TipoAuto[] = [
  "datos_postor", "relacion_unidades", "exigido_ofertado", "conductores", "matriz_cumplimiento",
  "absolucion_consultas", "cuadro_experiencia", "contactos", "relacion_adjuntos"];
/** Texto: admite **negrita**, {variables} y [COMPLETAR]. Nada más se interpreta. */
export type Bloque =
  | { id: string; tipo: "parrafo"; texto: string }
  | { id: string; tipo: "subtitulo"; texto: string; nivel: 2 | 3; numerado: boolean }
  | { id: string; tipo: "vinetas"; items: string[]; ordenada: boolean }
  | { id: string; tipo: "tabla"; titulo: string | null; columnas: string[]; filas: string[][]; anchos: number[] | null }
  | { id: string; tipo: "nota"; texto: string; tono: "info" | "aviso" }
  | { id: string; tipo: "imagen"; archivo: ArchivoRef | null; pie: string | null; anchoPct: number /* 10..100 */ }
  | { id: string; tipo: "salto_pagina" }
  | { id: string; tipo: "auto"; auto: TipoAuto; titulo: string | null; filasExtra: string[][]; conContacto: boolean };
export type TipoBloque = Bloque["tipo"];
export type Seccion = { id: string; titulo: string; activa: boolean; numerada: boolean; bloques: Bloque[] };

// ══ Paso 4 · Expediente ═════════════════════════════════════════════════════════
export type FuenteItem =
  | { tipo: "legajo"; codigo: CodigoLegajo; documentoId: number | null }           // null = el más reciente con archivo
  | { tipo: "docs_unidades"; doc: DocUnidadLic; roles: RolUnidad[] }             // uno por unidad, en orden de código
  | { tipo: "fotos_unidades"; roles: RolUnidad[] }
  | { tipo: "fichas_unidades"; roles: RolUnidad[] }                              // GENERADA: 1 página por unidad
  | { tipo: "docs_conductores"; doc: CodigoDocConductor; roles: RolConductor[] }
  | { tipo: "cuadro_experiencia" }                                               // GENERADA, con firma
  | { tipo: "sustentos_experiencia"; clase: SustentoTipo | "todos" }
  | { tipo: "seguro"; seguro: TipoSeguroLic }
  | { tipo: "adjunto"; archivo: ArchivoRef | null }                               // null = pendiente de subir
  | { tipo: "tabla"; tabla: "relacion_unidades" | "relacion_conductores" | "contactos" }   // GENERADA
  | { tipo: "propuesta" };                                                        // la propuesta técnica dentro del bloque
export type ItemExpediente = { id: string; incluido: boolean; titulo: string | null; fuente: FuenteItem };
export type BloqueExpediente = { id: string; activo: boolean; titulo: string; subtitulo: string; referencia: string; conPortada: boolean; items: ItemExpediente[] };
export type OpcionesFoliado = {
  modo: "ascendente" | "descendente" | "ninguno";
  formato: string;                     // "Folio {n}"
  digitos: number;                     // 3 → "001"
  posicion: "superior_derecha" | "inferior_derecha" | "inferior_centro";
  foliarPortadas: boolean;
  foliarBloquesSueltos: boolean;       // cada PDF por bloque lleva el folio que tendría en el completo
};
export type Expediente = { bloques: BloqueExpediente[]; foliado: OpcionesFoliado; propuestaEnCompleto: "primero" | "no" };

// ══ Documento (licitaciones.doc) y fila ════════════════════════════════════════
export type HallazgoAceptado = { clave: string; nota: string; por: string | null; en: InstanteISO };
export type DocLicitacion = {
  esquema: typeof ESQUEMA_DOC;
  bases: ArchivoBase[];
  requisitos: Requisito[];
  consultas: ConsultaAbsuelta[];
  analisis: { aplicadoId: number | null; aceptados: string[]; descartados: string[] };
  unidades: UnidadElegida[];
  conductores: ConductorElegido[];
  experiencia: SeleccionExperiencia;
  contactos: Contacto[];
  representante: Representante;
  portada: Portada;
  control: ControlDocumento;
  carta: Carta;
  glosario: { activo: boolean; entradas: EntradaGlosario[] };
  indice: { activo: boolean; niveles: 1 | 2 };
  secciones: Seccion[];
  cierre: Cierre;
  expediente: Expediente;
  aceptados: HallazgoAceptado[];
  copiaDe: { licitacionId: number; cliente_nombre: string; codigo: string | null } | null;
};
export type EstadoLicitacion = "preparacion" | "presentada" | "adjudicada" | "no_adjudicada" | "desierta" | "descartada";
export const ESTADOS_LICITACION: readonly EstadoLicitacion[] = ["preparacion", "presentada", "adjudicada", "no_adjudicada", "desierta", "descartada"];
export type Licitacion = {
  id: number; nombre: string; cliente_id: number | null; cliente_nombre: string;
  codigo: string | null; objeto: string | null; atencion: string | null;
  fecha_consultas: FechaISO | null; fecha_presentacion: FechaISO | null; hora_presentacion: string | null;
  fecha_inicio_servicio: FechaISO | null; plazo_meses: number | null;
  estado: EstadoLicitacion; archivada: boolean;
  doc: DocLicitacion; version: number;
  creado_por: string | null; creado_en: InstanteISO; actualizado_por: string | null; actualizado_en: InstanteISO;
};
/** Columnas que el guardado escribe JUNTO al doc (un solo UPDATE con .eq("version", v)). */
export const COLUMNAS_EDITABLES = [
  "nombre", "cliente_id", "cliente_nombre", "codigo", "objeto", "atencion", "fecha_consultas", "fecha_presentacion",
  "hora_presentacion", "fecha_inicio_servicio", "plazo_meses", "estado", "archivada", "doc"] as const;
/** Topes del documento: NO medidos, declarados. El lado seguro es bajarlos. */
export const TOPES_DOC = {
  maxSecciones: 60, maxBloquesSeccion: 300, maxTextoBloque: 8000, maxColumnas: 12, maxFilasTabla: 400,
  maxRequisitos: 300, maxUnidades: 60, maxConductores: 120, maxBloquesExpediente: 30, maxItemsBloque: 80,
  maxBytesDoc: 3_000_000, maxBytesArchivo: 50 * 1024 * 1024 } as const;

// ══ Contexto que el motor recibe ya leído (lib/licitaciones/datos.ts lo arma) ═════
export type EstadoLectura = "ok" | "sin_tabla" | "error";
export type DocUnidadERP = {
  origen: "documentos_vehiculo" | "documentos_tercero"; id: number; tipo: string; canonico: string | null;
  numero: string | null; fecha_emision: FechaISO | null; fecha_vencimiento: FechaISO | null;
  archivo_url: string | null; deEmpresa: boolean;              // documentos_tercero con vehiculo_id null
};
export type EmpresaTerceroERP = { id: number; razon_social: string; ruc: string | null; autorizacion_mtc: string | null; venc_autorizacion: FechaISO | null; estado: string | null };
export type UnidadERP = {
  clave: ClaveRecurso; flota: Flota; id: number; placa: string; marca: string | null; modelo: string | null;
  anio: number | null; capacidad: number | null; categoria: string | null; estado: string | null;
  foto_externa_url: string | null; foto_interna_url: string | null;
  empresa: EmpresaTerceroERP | null; docs: DocUnidadERP[];
};
export type FilaDocEmpresa = {
  id: number; titulo: string; categoria: string; alcance: string; archivo_url: string | null; archivo_nombre: string | null;
  fecha_emision: FechaISO | null; fecha_vencimiento: FechaISO | null;
  conductor_id: number | null; conductor_tercero_id: number | null; created_at: InstanteISO;
};
/** undefined = la columna NO existe en esa tabla (terceros) · null = existe y está vacía. Tri-estado. */
export type ConductorERP = {
  clave: ClaveRecurso; flota: Flota; id: number; nombre: string; dni: string | null; licencia: string | null;
  categoria_licencia: string | null; vencimiento_licencia: FechaISO | null;
  examen_medico_venc?: FechaISO | null; antecedentes_venc?: FechaISO | null; psicosometrico_venc?: FechaISO | null;
  estado: string | null; empresa: EmpresaTerceroERP | null; archivos: FilaDocEmpresa[];
};
export type Experiencia = {
  id: number; cliente_id: number | null; cliente_nombre: string; cliente_ruc: string | null;
  contacto_nombre: string | null; contacto_cargo: string | null; contacto_telefono: string | null; contacto_email: string | null;
  objeto: string; sector: string | null; zona: string | null; inicio: FechaISO; fin: FechaISO | null; vigente: boolean;
  sustento_tipo: SustentoTipo | null; sustento_ref: string | null; sustento_fecha: FechaISO | null;
  importe: number | null; moneda: Moneda; importe_incluye_igv: boolean | null;
  sustentos: ArchivoRef[]; notas: string | null; activo: boolean;
};
export type PersonaERP = { id: number; nombre: string; dni: string | null; cargo: string | null; telefono: string | null; email: string | null };
export type OtraLicitacion = { id: number; nombre: string; cliente_nombre: string; codigo: string | null; cliente_erp: string | null };
export type FuenteContexto = "perfil" | "unidades" | "conductores" | "legajo" | "experiencia" | "seguros" | "personal" | "otras";
export type ContextoLicitacion = {
  hoy: FechaISO;
  perfil: (PerfilEmpresa & { fecha_constitucion?: FechaISO | null }) | null;
  unidades: Record<string, UnidadERP>;        // por ClaveRecurso; ausente = no existe
  conductores: Record<string, ConductorERP>;
  legajo: FilaDocEmpresa[];                   // alcance 'empresa', categorías del legajo
  experiencia: Record<number, Experiencia>;
  seguros: FilaSeguro[];                      // cargarSeguros()
  personal: Record<number, PersonaERP>;
  otras: OtraLicitacion[];
  lecturas: Record<FuenteContexto, EstadoLectura>;
  migraciones: { anioTercero: boolean; conductorTercero: boolean; fechaConstitucion: boolean };
};
/** Resultado de comprobar un archivo (dry run o emisión). Clave = url. */
export type RevisionArchivo =
  | { url: string; ok: true; formato: "pdf" | "png" | "jpg"; paginas: number | null; bytes: number; sha256: string | null }
  | { url: string; ok: false; codigo: "pdf_protegido" | "pdf_ilegible" | "archivo_formato_no_soportado" | "archivo_no_descargable" | "archivo_demasiado_grande" | "archivo_externo"; detalle: string };

// ══ Revisión ════════════════════════════════════════════════════════════════════
export type CodigoHallazgo =
  // licitación y empresa
  | "fecha_presentacion_pasada" | "falta_fecha_presentacion" | "falta_fecha_inicio" | "fuente_no_leida"
  | "perfil_incompleto" | "autorizacion_sin_perfil" | "autorizacion_mtc_distinta" | "representante_incompleto" | "firma_falta"
  // requisitos
  | "requisito_obligatorio_pendiente" | "requisito_no_cumple" | "requisito_no_juzgable" | "requisito_manual_contradice"
  | "requisito_sin_sustento" | "requisito_sin_documento_en_expediente"
  // unidades
  | "unidad_no_existe" | "unidad_inactiva" | "unidad_repetida" | "unidad_codigo_repetido" | "unidad_tercerizada_prohibida"
  | "unidad_sin_anio" | "unidad_excede_antiguedad" | "unidad_sin_capacidad" | "unidad_capacidad_insuficiente"
  | "unidad_doc_falta" | "unidad_doc_vencido_al_presentar" | "unidad_doc_vence_antes_inicio" | "unidad_doc_sin_archivo"
  | "unidad_doc_archivo_externo" | "unidad_sin_fotos" | "unidades_titulares_insuficientes" | "reten_insuficiente"
  | "tercero_sin_autorizacion"
  // conductores
  | "conductor_no_existe" | "conductor_repetido" | "conductor_tercerizado_prohibido" | "conductor_sin_licencia"
  | "conductor_licencia_vencida" | "conductor_licencia_vence_antes_inicio" | "conductor_categoria_insuficiente"
  | "conductor_doc_vencido" | "conductor_doc_no_registrado" | "conductor_doc_sin_archivo" | "conductor_doc_fechas_distintas"
  | "conductores_relevo_insuficientes"
  // legajo
  | "legajo_falta" | "legajo_sin_archivo" | "legajo_vencido" | "legajo_antiguo" | "legajo_sin_fecha_emision"
  | "legajo_documento_fijado_no_existe"
  // experiencia
  | "experiencia_no_existe" | "experiencia_monto_insuficiente" | "experiencia_anios_insuficientes"
  | "experiencia_cartas_insuficientes" | "experiencia_fuera_de_ventana" | "experiencia_sin_sustento"
  | "experiencia_sin_importe" | "experiencia_moneda_mixta" | "experiencia_sin_fecha_constitucion"
  // seguros
  | "seguro_falta" | "seguro_vencido" | "seguro_vence_antes_inicio" | "seguro_sin_archivo"
  // contenido
  | "variable_sin_resolver" | "marca_completar" | "texto_de_otra_licitacion" | "afirma_flota_propia"
  | "seccion_vacia" | "imagen_sin_archivo" | "tabla_vacia" | "sin_secciones"
  // expediente y archivos
  | "expediente_bloque_vacio" | "expediente_item_sin_archivo" | "expediente_falta_obligatorio"
  | "expediente_item_archivo_externo" | "adjunto_no_unible" | "expediente_pesa_mucho"
  | "pdf_protegido" | "pdf_ilegible" | "archivo_no_descargable" | "archivo_formato_no_soportado"
  | "archivo_demasiado_grande" | "archivo_cambio_desde_emision";
/** La gravedad se DECLARA por código, nunca se calcula. La matriz exige una entrada por código. */
export const GRAVEDAD_HALLAZGO: Record<CodigoHallazgo, Gravedad> = {
  fecha_presentacion_pasada: "aviso", falta_fecha_presentacion: "aviso", falta_fecha_inicio: "info", fuente_no_leida: "aviso",
  perfil_incompleto: "aviso", autorizacion_sin_perfil: "aviso", autorizacion_mtc_distinta: "alarma",
  representante_incompleto: "alarma", firma_falta: "aviso",
  requisito_obligatorio_pendiente: "alarma", requisito_no_cumple: "alarma", requisito_no_juzgable: "aviso",
  requisito_manual_contradice: "aviso", requisito_sin_sustento: "aviso", requisito_sin_documento_en_expediente: "aviso",
  unidad_no_existe: "alarma", unidad_inactiva: "aviso", unidad_repetida: "alarma", unidad_codigo_repetido: "alarma",
  unidad_tercerizada_prohibida: "alarma", unidad_sin_anio: "aviso", unidad_excede_antiguedad: "alarma",
  unidad_sin_capacidad: "aviso", unidad_capacidad_insuficiente: "alarma", unidad_doc_falta: "alarma",
  unidad_doc_vencido_al_presentar: "alarma", unidad_doc_vence_antes_inicio: "aviso", unidad_doc_sin_archivo: "aviso",
  unidad_doc_archivo_externo: "aviso", unidad_sin_fotos: "aviso", unidades_titulares_insuficientes: "alarma",
  reten_insuficiente: "alarma", tercero_sin_autorizacion: "aviso",
  conductor_no_existe: "alarma", conductor_repetido: "alarma", conductor_tercerizado_prohibido: "alarma",
  conductor_sin_licencia: "alarma", conductor_licencia_vencida: "alarma", conductor_licencia_vence_antes_inicio: "aviso",
  conductor_categoria_insuficiente: "alarma", conductor_doc_vencido: "alarma", conductor_doc_no_registrado: "aviso",
  conductor_doc_sin_archivo: "aviso", conductor_doc_fechas_distintas: "aviso", conductores_relevo_insuficientes: "alarma",
  legajo_falta: "alarma", legajo_sin_archivo: "alarma", legajo_vencido: "alarma", legajo_antiguo: "alarma",
  legajo_sin_fecha_emision: "aviso", legajo_documento_fijado_no_existe: "aviso",
  experiencia_no_existe: "aviso", experiencia_monto_insuficiente: "alarma", experiencia_anios_insuficientes: "alarma",
  experiencia_cartas_insuficientes: "alarma", experiencia_fuera_de_ventana: "aviso", experiencia_sin_sustento: "aviso",
  experiencia_sin_importe: "info", experiencia_moneda_mixta: "info", experiencia_sin_fecha_constitucion: "aviso",
  seguro_falta: "alarma", seguro_vencido: "alarma", seguro_vence_antes_inicio: "aviso", seguro_sin_archivo: "aviso",
  variable_sin_resolver: "alarma", marca_completar: "alarma", texto_de_otra_licitacion: "alarma", afirma_flota_propia: "alarma",
  seccion_vacia: "aviso", imagen_sin_archivo: "aviso", tabla_vacia: "info", sin_secciones: "alarma",
  expediente_bloque_vacio: "aviso", expediente_item_sin_archivo: "aviso", expediente_falta_obligatorio: "alarma",
  expediente_item_archivo_externo: "aviso", adjunto_no_unible: "aviso", expediente_pesa_mucho: "aviso",
  pdf_protegido: "alarma", pdf_ilegible: "alarma", archivo_no_descargable: "alarma", archivo_formato_no_soportado: "aviso",
  archivo_demasiado_grande: "aviso", archivo_cambio_desde_emision: "info",
};
export type DondeSeCorrige = { paso: Paso; ancla: string | null } | { ruta: string; etiqueta: string };
export type SujetoHallazgo = {
  tipo: "licitacion" | "requisito" | "unidad" | "conductor" | "legajo" | "experiencia" | "seguro" | "seccion"
      | "bloque" | "bloque_expediente" | "item_expediente" | "archivo";
  id: string; rotulo: string;
};
export type Hallazgo = {
  clave: string;                      // `${codigo}|${sujeto.tipo}:${sujeto.id}|${requisitoId ?? ""}|${extra}` — estable
  codigo: CodigoHallazgo; gravedad: Gravedad;
  titulo: string; texto: string; arreglo: string; donde: DondeSeCorrige;
  sujeto: SujetoHallazgo; requisitoId: string | null;
  aceptado: HallazgoAceptado | null;
};
export type EstadoFinal = "cumple" | "no_cumple" | "no_aplica" | "pendiente" | "no_se_puede_juzgar";
export type EvaluacionRequisito = {
  requisitoId: string;
  auto: { estado: "cumple" | "no_cumple" | "no_se_puede_juzgar"; codigos: CodigoHallazgo[]; detalle: string; sustento: string | null } | null;
  final: EstadoFinal;
  fuente: "manual" | "regla" | "ninguna";
};
export type Revision = {
  hallazgos: Hallazgo[]; evaluaciones: EvaluacionRequisito[]; cuenta: Record<Gravedad, number>;
  fechaReferencia: FechaISO; referenciaEs: "presentacion" | "hoy";
};

// ══ Lo que imprime el PDF (resolverDocumento) ══════════════════════════════════
/** Texto ya con variables resueltas; el PDF y la vista previa parsean **negrita** con trozosDe (texto.ts). */
export type BloqueResuelto =
  | { id: string; tipo: "parrafo"; texto: string }
  | { id: string; tipo: "subtitulo"; texto: string; nivel: 2 | 3; numero: string | null }
  | { id: string; tipo: "vinetas"; items: string[]; ordenada: boolean }
  | { id: string; tipo: "tabla"; titulo: string | null; columnas: string[]; filas: string[][]; anchos: number[] | null; pie: string[] | null }
  | { id: string; tipo: "nota"; texto: string; tono: "info" | "aviso" }
  | { id: string; tipo: "imagen"; url: string; pie: string | null; anchoPct: number }
  | { id: string; tipo: "salto_pagina" };
export type SeccionResuelta = { id: string; numero: string | null; titulo: string; bloques: BloqueResuelto[] };
export type DocumentoResuelto = {
  cabecera: string; color: string;
  portada: { modo: "generada" | "imagen"; imagenUrl: string | null; titulo: string; subtitulo: string; lineas: string[] };
  control: [string, string][] | null;
  carta: { lugarFecha: string; destinatario: string[]; referencia: string; cuerpo: string[]; despedida: string; conFirma: boolean } | null;
  glosario: [string, string][] | null;
  indice: { niveles: 1 | 2 } | null;
  secciones: SeccionResuelta[];
  cierre: { texto: string; conFirma: boolean } | null;
  firmante: { nombre: string; dni: string; cargo: string; firmaUrl: string | null } | null;
  pie: { izquierda: string; derecha: string };              // derecha lleva "{pagina} de {total}"
};
export type EntradaIndice = { nivel: 1 | 2; numero: string | null; titulo: string; pagina: number };
export type TrazaLic = { pagina: number; zona: "cabecera" | "cuerpo" | "pie" | "folio" | "marca"; texto: string; x: number; y: number; ancho: number };

// ══ Expediente resuelto (resolverExpediente) ═══════════════════════════════════
export type TablaPlano = { columnas: string[]; filas: string[][]; pie: string[] | null };
export type FichaUnidad = {
  codigo: string; rol: RolUnidad; uso: string; placa: string; marcaModelo: string; anio: number | null; capacidad: number | null;
  flota: string; fotoExternaUrl: string | null; fotoInternaUrl: string | null;
  documentos: { tipo: string; numero: string | null; vence: FechaISO | null; estado: string; adjunto: boolean }[];
};
export type CuadroExperiencia = {
  encabezado: string[]; introduccion: string; tabla: TablaPlano;
  totales: { moneda: Moneda; importe: number }[];            // NUNCA se suman monedas distintas
  firmante: { nombre: string; dni: string; cargo: string; firmaUrl: string | null } | null;
};
export type ParteFuente =
  | { tipo: "archivo"; itemId: string; titulo: string; url: string; nombre: string; origen: OrigenArchivo; etiquetaFuente: string }
  | { tipo: "ficha_unidad"; itemId: string; ficha: FichaUnidad }
  | { tipo: "cuadro_experiencia"; itemId: string; cuadro: CuadroExperiencia }
  | { tipo: "tabla"; itemId: string; titulo: string; tabla: TablaPlano }
  | { tipo: "propuesta"; itemId: string }
  | { tipo: "faltante"; itemId: string; titulo: string; codigo: CodigoHallazgo };
export type SeparadorResuelto = { titulo: string; subtitulo: string; referencia: string; contenido: string[] };
export type BloqueExpedienteResuelto = { id: string; separador: SeparadorResuelto; conPortada: boolean; partes: ParteFuente[] };
export type ExpedienteResuelto = { bloques: BloqueExpedienteResuelto[]; cabecera: string; color: string };

// ══ Emisión ═════════════════════════════════════════════════════════════════════
export type OpcionesEmision = { propuesta: boolean; bloques: boolean; completo: boolean; empaque: "zip" | "sueltos"; subirCopias: boolean };
export type TipoArchivoEmitido = "propuesta" | "bloque" | "expediente_completo" | "zip";
export type ArchivoEmitido = {
  nombre: string; tipo: TipoArchivoEmitido; bloqueId: string | null; bytes: number; paginas: number | null; sha256: string;
  url: string | null;                 // identificador en el bucket; null = no se subió
  motivoNoSubido: string | null; folios: { desde: number; hasta: number } | null;
};
export type OmitidoEmision = { itemId: string; bloqueId: string; titulo: string; url: string | null; codigo: CodigoHallazgo; detalle: string };
export type HallazgoEmitido = Pick<Hallazgo, "clave" | "codigo" | "gravedad" | "texto"> & { aceptado: boolean; nota: string | null };
export type FotoEmision = {
  licitacion: Omit<Licitacion, "doc">; doc: DocLicitacion; documento: DocumentoResuelto; expediente: ExpedienteResuelto;
  fuentes: { itemId: string; url: string; sha256: string | null; bytes: number; paginas: number | null }[];
  empresa: { nombre: string; razonSocial: string; ruc: string; direccion: string; autorizacion: string };
  hoy: FechaISO;
};
export type FilaEmision = {
  id: number; licitacion_id: number; version: number; carpeta: string; emitido_por: string; emitido_en: InstanteISO;
  doc_version: number; firma: string; foto: FotoEmision; archivos: ArchivoEmitido[];
  hallazgos: HallazgoEmitido[]; omitidos: OmitidoEmision[]; nota: string | null;
};
export type FaseEmision = "comprobando" | "bajando" | "armando_bloques" | "armando_propuesta" | "foliando" | "empacando" | "subiendo" | "registrando" | "listo";
export type ProgresoEmision = { fase: FaseEmision; hecho: number; total: number; detalle: string };
export type ResultadoEmision =
  | { ok: true; emision: FilaEmision | null; archivos: { nombre: string; blob: Blob }[]; omitidos: OmitidoEmision[]; avisos: string[] }
  | { ok: false; codigo: "conflicto_version" | "sin_nada_que_emitir" | "registro_fallido" | "cancelada" | "memoria"; detalle: string };

// ══ Análisis IA de las bases ════════════════════════════════════════════════════
export type RequisitoPropuesto = { clave: string; numeral: string | null; texto: string; categoria: CategoriaRequisito; obligatorio: boolean; regla: Regla | null; cita: CitaBases };
export type AnalisisBases = {
  concurso: {
    cliente_nombre: string | null; codigo: string | null; objeto: string | null; atencion: string | null;
    fecha_consultas: FechaISO | null; fecha_presentacion: FechaISO | null; hora_presentacion: string | null;
    fecha_inicio_servicio: FechaISO | null; plazo_meses: number | null;
  };
  requisitos: RequisitoPropuesto[];
  consultas: { clave: string; numero: string | null; pregunta: string; respuesta: string; cita: CitaBases }[];
  estructura: { clave: string; titulo: string; subtitulo: string; referencia: string; contenido: string[] }[];
  penalidades: { clave: string; texto: string; cita: CitaBases }[];
  criterios: { clave: string; texto: string; peso: string | null; cita: CitaBases }[];
  advertencias: string[];
};
export type AvisoAnalisis = { codigo: "regla_desconocida" | "fecha_invalida" | "numero_fuera_de_rango" | "texto_recortado" | "archivo_omitido" | "categoria_desconocida"; detalle: string };
export type EntradaAnalisis = { licitacion_id: number; archivo_ids: string[]; texto: string | null; estimar: boolean };
export type CodigoErrorAnalisis =
  | "sin_permiso" | "origen" | "tasa" | "tope_diario" | "en_curso" | "entrada_invalida" | "sin_migracion"
  | "archivo_ajeno" | "sin_archivos" | "no_es_pdf" | "pdf_protegido" | "demasiado_grande" | "demasiadas_paginas"
  | "demasiados_tokens" | "sin_clave" | "error_modelo" | "rechazo" | "respuesta_cortada" | "respuesta_ilegible";
export type RespuestaAnalisis =
  | { ok: true; modo: "estimacion"; tokensEntrada: number; paginas: number; costoUsdMax: number | null }
  | { ok: true; modo: "analisis"; analisisId: number; resultado: AnalisisBases; avisos: AvisoAnalisis[]; uso: { tokensEntrada: number; tokensSalida: number; costoUsd: number | null } }
  | { ok: false; codigo: CodigoErrorAnalisis; error: string; reintentarEnSeg?: number };

// ══ Importación .docx ════════════════════════════════════════════════════════════
export type ImagenImportada = { clave: string; ruta: string; mime: "image/png" | "image/jpeg" | "image/gif" | "image/x-emf" | "image/x-wmf" | "otro"; bytes: Uint8Array; anchoEmu: number | null; altoEmu: number | null };
export type AvisoImportacion = {
  codigo: "estilo_desconocido" | "imagen_no_soportada" | "tabla_combinada" | "subtitulo_sospechoso" | "cuadro_de_texto"
        | "grafico_omitido" | "indice_omitido" | "numeracion_quitada" | "sin_titulos" | "lista_numerada"
        // recortado: un tope de TOPES_DOC cortó algo · imagen_en_tabla: una imagen de una celda pasó debajo de su
        // tabla · dato_omitido: algo sin campo en el ERP (fila del control, fecha ilegible, nota al pie, altChunk).
        | "recortado" | "imagen_en_tabla" | "dato_omitido";
  texto: string; donde: string | null;
};
export type ResultadoImportacion =
  | { ok: true; secciones: Seccion[];
      preliminares: { control: Partial<ControlDocumento> | null; glosario: EntradaGlosario[] | null; carta: Partial<Carta> | null; portadaImagen: string | null; resto: Bloque[] };
      imagenes: ImagenImportada[]; pendientes: Record<string /* bloqueId */, string /* clave de imagen */>; avisos: AvisoImportacion[] }
  | { ok: false; codigo: "archivo_no_docx" | "demasiado_grande" | "sin_documento" | "xml_ilegible"; detalle: string };
