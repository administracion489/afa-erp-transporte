// lib/licitaciones/normalizar.ts — El documento de una licitación (licitaciones.doc), siempre con forma
// válida. Módulo PURO.
//
// El jsonb lo escriben varias pantallas, la importación de Word y el análisis IA, y puede venir de una
// versión vieja del esquema o a medio guardar. Todo el módulo lee a través de `normalizarDoc`:
//
//  · TOLERA lo que no entiende: un campo con otro tipo cae a su valor por defecto, un elemento que no se
//    puede interpretar se descarta (nunca lanza). Un bloque de tipo desconocido no tumba la sección.
//  · Es IDEMPOTENTE: normalizarDoc(normalizarDoc(x)) ≡ normalizarDoc(x). Los ids que faltan o se repiten
//    se generan con `nuevoId` UNA vez; en la segunda pasada ya existen y no se vuelve a llamar. Por eso
//    las claves de los hallazgos aceptados (que llevan ids) sobreviven a un guardado.
//  · Recorta a TOPES_DOC por elementos y por caracteres COMPLETOS (un emoji partido o un NUL hacen que
//    Postgres rechace el documento entero).
//  · Aplica el contrato: con `personalId`, nombre/cargo/teléfono/correo del contacto y nombre/DNI/cargo
//    del representante van VACÍOS (se derivan de personal_administrativo al abrir; D2).

import { esMimePermitido, mimeDeNombre } from "./archivos";
import { normalizarCategoria } from "../licencias-conducir";
import {
  CATEGORIAS_REQUISITO, CODIGOS_DOC_CONDUCTOR, CODIGOS_LEGAJO, DOCS_UNIDAD_LIC, ESQUEMA_DOC, TIPOS_AUTO, TOPES_DOC,
  type ArchivoBase, type ArchivoRef, type Bloque, type BloqueExpediente, type Carta, type CategoriaLicencia,
  type CitaBases, type Cierre, type ConductorElegido, type ConsultaAbsuelta, type Contacto, type ControlDocumento,
  type DocLicitacion, type EntradaGlosario, type Expediente, type FuenteItem, type HallazgoAceptado,
  type ItemExpediente, type Licitacion, type OpcionesFoliado, type Portada, type Regla, type Representante,
  type Requisito, type RolConductor, type RolUnidad, type Seccion, type SeleccionExperiencia, type TipoBase,
  type TipoSeguroLic, type UnidadElegida,
} from "./tipos";
import {
  claveRecurso, enteroEn, esObjeto, fechaONull, limpiarTexto, lista, numeroEn, textoCorto, textoONull,
} from "./util";

/** Color de la portada y la cabecera cuando no hay uno válido. No es un dato de ninguna empresa. */
export const COLOR_DEFECTO = "#0b315f";

/** Foliado por defecto (R7): ascendente, «Folio {n}», 3 dígitos, inferior derecha, portadas foliadas. */
export const FOLIADO_DEFECTO: OpcionesFoliado = {
  modo: "ascendente", formato: "Folio {n}", digitos: 3, posicion: "inferior_derecha",
  foliarPortadas: true, foliarBloquesSueltos: true,
};

const TIPOS_BASE: readonly TipoBase[] = ["bases", "tdr", "absolucion", "anexo", "requisitos_cliente", "otro"];
const TIPOS_SEGURO_LIC: readonly TipoSeguroLic[] = ["responsabilidad_civil", "deshonestidad", "todo_riesgo", "sctr_salud", "sctr_pension", "vida_ley"];
const SUSTENTOS = ["oc", "factura", "carta", "contrato", "conformidad", "otro"] as const;
const ROLES_UNIDAD: readonly RolUnidad[] = ["titular", "reten"];
const ROLES_CONDUCTOR: readonly RolConductor[] = ["titular", "relevo"];
const DOCS_CONDUCTOR_REGLA = ["record_conductor", "antecedentes_penales", "antecedentes_policiales", "examen_medico", "psicosometrico"] as const;

// Topes de texto que TOPES_DOC no declara (no medidos; el lado seguro es bajarlos).
const T = {
  id: 100, titulo: 200, corto: 120, numeral: 40, requisito: 1000, sustento: 1000, cita: 500,
  nombreArchivo: 200, maxBases: 50, maxConsultas: 300, maxContactos: 40, maxGlosario: 200,
  maxVinetas: 300, maxExperiencia: 200, maxAceptados: 1000, maxIdsAnalisis: 2000, clave: 400, nota: 1000,
  subtituloPortada: 300, pieImagen: 500, definicion: 2000, version: 40, codigoDoc: 80,
  confidencialidad: 300, cartaLargo: 1000, referenciaBloque: 300, formatoFolio: 40,
} as const;
/** Los topes de texto con que se NORMALIZA el doc. La pantalla los usa como maxLength: si pusiera los
 *  suyos, un texto más largo se cortaría en silencio al guardar. */
export const LIMITES_TEXTO = T;

const incluye = <X extends string>(lst: readonly X[], x: unknown): x is X => typeof x === "string" && (lst as readonly string[]).includes(x);
const bool = (x: unknown, def: boolean): boolean => (typeof x === "boolean" ? x : def);
const color = (x: unknown): string => (typeof x === "string" && /^#[0-9a-fA-F]{6}$/.test(x.trim()) ? x.trim().toLowerCase() : COLOR_DEFECTO);
const texto = (x: unknown): string => limpiarTexto(x, TOPES_DOC.maxTextoBloque);

/** Fábrica de ids: conserva el id si es válido y no se repite en su ámbito; si no, genera uno. */
function ids(nuevoId: () => string) {
  const vistos = new Map<string, Set<string>>();
  return (ambito: string, x: unknown): string => {
    let set = vistos.get(ambito);
    if (!set) { set = new Set(); vistos.set(ambito, set); }
    const c = typeof x === "string" ? textoCorto(x, T.id) : "";
    if (c && !set.has(c)) { set.add(c); return c; }
    let n = textoCorto(nuevoId(), T.id);
    while (!n || set.has(n)) n = textoCorto(nuevoId(), T.id) || `id-${set.size + 1}`;
    set.add(n);
    return n;
  };
}
type Ids = ReturnType<typeof ids>;

// ══ Archivos ═══════════════════════════════════════════════════════════════════

/** Una referencia a archivo válida, o null (sin url no hay archivo). */
export function normalizarArchivo(raw: unknown, id: (x: unknown) => string): ArchivoRef | null {
  if (!esObjeto(raw)) return null;
  const url = textoCorto(raw.url, 2000);
  if (!url) return null;
  const nombre = textoCorto(raw.nombre, T.nombreArchivo) || "archivo";
  const mime = esMimePermitido(raw.mime) ? raw.mime : mimeDeNombre(nombre);
  if (!mime) return null;
  const sha = typeof raw.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(raw.sha256) ? raw.sha256.toLowerCase() : null;
  return {
    id: id(raw.id), url, nombre, mime,
    bytes: enteroEn(raw.bytes, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    sha256: sha,
    paginas: mime === "application/pdf" ? enteroEn(raw.paginas, 1, 100_000) : null,
    subidoEn: textoCorto(raw.subidoEn, 40),
  };
}

function normalizarCita(raw: unknown): CitaBases | null {
  if (!esObjeto(raw)) return null;
  const c: CitaBases = {
    archivoId: textoONull(raw.archivoId, T.id),
    pagina: enteroEn(raw.pagina, 1, 100_000),
    texto: textoONull(raw.texto, T.cita),
  };
  return c.archivoId || c.pagina || c.texto ? c : null;
}

// ══ Reglas ═════════════════════════════════════════════════════════════════════

/** Rangos de los parámetros de una regla: lo que normalizarRegla GUARDA. El editor de reglas valida con
 *  los mismos (si validara con otros, una regla «válida» en pantalla se perdería al guardar). */
export const RANGOS_REGLA = {
  antig: [1, 3650], uAnios: [0, 60], asientos: [1, 120], n: [1, 500], eAnios: [1, 100], monto: [0.01, 1e12],
} as const;
const referencia = (x: unknown) => (x === "inicio_servicio" ? "inicio_servicio" as const : "presentacion" as const);

/** Una regla del catálogo cerrado con parámetros válidos, o null (se juzga a mano). */
export function normalizarRegla(raw: unknown): Regla | null {
  if (!esObjeto(raw)) return null;
  const antig = (x: unknown) => enteroEn(x, ...RANGOS_REGLA.antig);
  switch (raw.tipo) {
    case "doc_empresa":
      return incluye(CODIGOS_LEGAJO, raw.legajo) ? { tipo: "doc_empresa", legajo: raw.legajo, antiguedadMaxDias: antig(raw.antiguedadMaxDias) } : null;
    case "unidad_antiguedad_max": {
      const anios = enteroEn(raw.anios, ...RANGOS_REGLA.uAnios);
      return anios === null ? null : { tipo: "unidad_antiguedad_max", anios, referencia: referencia(raw.referencia) };
    }
    case "unidad_capacidad_min": {
      const asientos = enteroEn(raw.asientos, ...RANGOS_REGLA.asientos);
      return asientos === null ? null : { tipo: "unidad_capacidad_min", asientos, uso: textoONull(raw.uso, T.titulo) };
    }
    case "unidad_doc":
      return incluye(DOCS_UNIDAD_LIC, raw.doc) ? { tipo: "unidad_doc", doc: raw.doc, vigenteAl: referencia(raw.vigenteAl) } : null;
    case "unidad_fotos":
      return { tipo: "unidad_fotos" };
    case "unidades_titulares_min":
    case "unidades_reten_min":
    case "conductores_relevo_min":
    case "experiencia_cartas_min": {
      const n = enteroEn(raw.n, ...RANGOS_REGLA.n);
      return n === null ? null : ({ tipo: raw.tipo, n } as Regla);
    }
    case "conductor_licencia": {
      const cats = [...new Set(lista(raw.categorias).map(normalizarCategoria).filter((c): c is CategoriaLicencia => !!c))];
      return cats.length ? { tipo: "conductor_licencia", categorias: cats } : null;
    }
    case "conductor_doc":
      return incluye(DOCS_CONDUCTOR_REGLA, raw.doc) ? { tipo: "conductor_doc", doc: raw.doc, antiguedadMaxDias: antig(raw.antiguedadMaxDias) } : null;
    case "prohibe_subcontratacion":
      return { tipo: "prohibe_subcontratacion" };
    case "experiencia_anios_min": {
      const anios = enteroEn(raw.anios, ...RANGOS_REGLA.eAnios);
      return anios === null ? null : { tipo: "experiencia_anios_min", anios, desde: raw.desde === "constitucion" ? "constitucion" : "primer_contrato" };
    }
    case "experiencia_monto_min": {
      const monto = numeroEn(raw.monto, ...RANGOS_REGLA.monto);
      return monto === null ? null : { tipo: "experiencia_monto_min", monto, moneda: raw.moneda === "USD" ? "USD" : "PEN" };
    }
    case "experiencia_ventana_anios": {
      const anios = enteroEn(raw.anios, ...RANGOS_REGLA.eAnios);
      return anios === null ? null : { tipo: "experiencia_ventana_anios", anios };
    }
    case "seguro":
      return incluye(TIPOS_SEGURO_LIC, raw.seguro) ? { tipo: "seguro", seguro: raw.seguro, vigenteAl: referencia(raw.vigenteAl) } : null;
    default:
      return null;
  }
}

// ══ Paso 1 ═════════════════════════════════════════════════════════════════════

function normalizarRequisito(raw: unknown, id: Ids): Requisito | null {
  if (!esObjeto(raw)) return null;
  const manual = raw.manual === "cumple" || raw.manual === "no_cumple" || raw.manual === "no_aplica" ? raw.manual : null;
  const origen = raw.origen === "ia" || raw.origen === "plantilla" || raw.origen === "copia" ? raw.origen : "manual";
  return {
    id: id("requisito", raw.id),
    numeral: textoONull(raw.numeral, T.numeral),
    texto: limpiarTexto(raw.texto, T.requisito),
    categoria: incluye(CATEGORIAS_REQUISITO, raw.categoria) ? raw.categoria : "otro",
    obligatorio: bool(raw.obligatorio, true),
    regla: normalizarRegla(raw.regla),
    manual,
    cumpleTexto: textoONull(raw.cumpleTexto, T.corto),
    sustento: limpiarTexto(raw.sustento, T.sustento),
    bloqueExpedienteId: textoONull(raw.bloqueExpedienteId, T.id),
    enMatriz: bool(raw.enMatriz, true),
    origen,
    cita: normalizarCita(raw.cita),
  };
}

function normalizarConsulta(raw: unknown, id: Ids): ConsultaAbsuelta | null {
  if (!esObjeto(raw)) return null;
  return {
    id: id("consulta", raw.id),
    numero: textoONull(raw.numero, T.numeral),
    pregunta: texto(raw.pregunta),
    respuesta: texto(raw.respuesta),
    incorporacion: texto(raw.incorporacion),
    cita: normalizarCita(raw.cita),
  };
}

// ══ Paso 2 ═════════════════════════════════════════════════════════════════════

function normalizarUnidad(raw: unknown, id: Ids): UnidadElegida | null {
  if (!esObjeto(raw)) return null;
  const clave = claveRecurso(raw.clave);
  if (!clave) return null;
  return {
    id: id("unidad", raw.id), clave,
    codigo: textoCorto(raw.codigo, 20),
    rol: raw.rol === "reten" ? "reten" : "titular",
    uso: textoCorto(raw.uso, T.titulo),
    capacidadExigida: enteroEn(raw.capacidadExigida, 1, 120),
  };
}

function normalizarConductor(raw: unknown, id: Ids): ConductorElegido | null {
  if (!esObjeto(raw)) return null;
  const clave = claveRecurso(raw.clave);
  if (!clave) return null;
  return {
    id: id("conductor", raw.id), clave,
    rol: raw.rol === "relevo" ? "relevo" : "titular",
    unidadCodigo: textoONull(raw.unidadCodigo, 20),
  };
}

function normalizarExperiencia(raw: unknown): SeleccionExperiencia {
  const r = esObjeto(raw) ? raw : {};
  const vistos = new Set<number>();
  const idsExp: number[] = [];
  for (const x of lista(r.ids)) {
    const n = enteroEn(x, 1, Number.MAX_SAFE_INTEGER);
    if (n !== null && !vistos.has(n) && idsExp.length < T.maxExperiencia) { vistos.add(n); idsExp.push(n); }
  }
  return {
    ids: idsExp,
    ventanaAnios: enteroEn(r.ventanaAnios, 1, 100),
    conContacto: bool(r.conContacto, false),
    introduccion: texto(r.introduccion),
  };
}

function normalizarContacto(raw: unknown, id: Ids): Contacto | null {
  if (!esObjeto(raw)) return null;
  const personalId = enteroEn(raw.personalId, 1, Number.MAX_SAFE_INTEGER);
  const libre = (x: unknown) => (personalId ? "" : textoCorto(x, T.corto));
  return {
    id: id("contacto", raw.id),
    rol: textoCorto(raw.rol, T.corto),
    personalId,
    nombre: libre(raw.nombre), cargo: libre(raw.cargo), telefono: libre(raw.telefono), email: libre(raw.email),
    emergencia: bool(raw.emergencia, false),
  };
}

function normalizarRepresentante(raw: unknown, id: Ids): Representante {
  const r = esObjeto(raw) ? raw : {};
  const personalId = enteroEn(r.personalId, 1, Number.MAX_SAFE_INTEGER);
  const libre = (x: unknown, max: number) => (personalId ? "" : textoCorto(x, max));
  return {
    personalId,
    nombre: libre(r.nombre, T.corto), dni: libre(r.dni, 20), cargo: libre(r.cargo, T.corto),
    firma: normalizarArchivo(r.firma, (x) => id("archivo_firma", x)),
  };
}

// ══ Paso 3 ═════════════════════════════════════════════════════════════════════

function normalizarPortada(raw: unknown, id: Ids): Portada {
  const r = esObjeto(raw) ? raw : {};
  return {
    modo: r.modo === "imagen" ? "imagen" : "generada",
    imagen: normalizarArchivo(r.imagen, (x) => id("archivo_portada", x)),
    titulo: textoCorto(r.titulo, T.titulo) || "Propuesta Técnica",
    subtitulo: textoCorto(r.subtitulo, T.subtituloPortada),
    cabecera: textoCorto(r.cabecera, T.titulo),
    color: color(r.color),
  };
}

function normalizarControl(raw: unknown): ControlDocumento {
  const r = esObjeto(raw) ? raw : {};
  const c = (x: unknown) => textoCorto(x, T.titulo);
  return {
    activo: bool(r.activo, true),
    documento: c(r.documento), version: textoCorto(r.version, T.version), codigo: textoCorto(r.codigo, T.codigoDoc),
    elaboradoPor: c(r.elaboradoPor), revisadoPor: c(r.revisadoPor), aprobadoPor: c(r.aprobadoPor),
    fecha: fechaONull(r.fecha),
    confidencialidad: textoCorto(r.confidencialidad, T.confidencialidad),
  };
}

function normalizarCarta(raw: unknown): Carta {
  const r = esObjeto(raw) ? raw : {};
  return {
    activa: bool(r.activa, true),
    lugarFecha: textoCorto(r.lugarFecha, T.titulo),
    destinatario: limpiarTexto(r.destinatario, T.cartaLargo),
    atencion: textoCorto(r.atencion, T.titulo),
    referencia: limpiarTexto(r.referencia, T.cartaLargo),
    cuerpo: texto(r.cuerpo),
    despedida: textoCorto(r.despedida, T.titulo) || "Atentamente,",
    conFirma: bool(r.conFirma, true),
  };
}

function normalizarCierre(raw: unknown): Cierre {
  const r = esObjeto(raw) ? raw : {};
  return { activo: bool(r.activo, false), texto: texto(r.texto), conFirma: bool(r.conFirma, true) };
}

/** Celdas de una tabla: cada fila con exactamente `ncol` celdas (de texto), hasta maxFilasTabla. */
function filasTabla(raw: unknown, ncol: number): string[][] {
  return lista(raw).filter(Array.isArray).slice(0, TOPES_DOC.maxFilasTabla).map((f) => {
    const celdas = (f as unknown[]).slice(0, ncol).map((c) => (typeof c === "number" ? String(c) : texto(c)));
    while (celdas.length < ncol) celdas.push("");
    return celdas;
  });
}

function normalizarBloque(raw: unknown, id: Ids): Bloque | null {
  if (!esObjeto(raw)) return null;
  const bid = () => id("bloque", raw.id);
  switch (raw.tipo) {
    case "parrafo": return { id: bid(), tipo: "parrafo", texto: texto(raw.texto) };
    case "subtitulo": return { id: bid(), tipo: "subtitulo", texto: textoCorto(raw.texto, T.titulo), nivel: raw.nivel === 3 ? 3 : 2, numerado: bool(raw.numerado, true) };
    case "vinetas": return { id: bid(), tipo: "vinetas", items: lista(raw.items).slice(0, T.maxVinetas).map(texto), ordenada: bool(raw.ordenada, false) };
    case "tabla": {
      const cols = lista(raw.columnas).slice(0, TOPES_DOC.maxColumnas).map((c) => textoCorto(c, T.titulo));
      const anchoFilas = Math.min(TOPES_DOC.maxColumnas, Math.max(0, ...lista(raw.filas).filter(Array.isArray).map((f) => (f as unknown[]).length)));
      const ncol = cols.length || anchoFilas;
      const columnas = cols.length ? cols : Array.from({ length: ncol }, () => "");
      const a = lista(raw.anchos);
      const anchos = a.length === ncol && ncol > 0 && a.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0) ? (a as number[]) : null;
      return { id: bid(), tipo: "tabla", titulo: textoONull(raw.titulo, T.titulo), columnas, filas: filasTabla(raw.filas, ncol), anchos };
    }
    case "nota": return { id: bid(), tipo: "nota", texto: texto(raw.texto), tono: raw.tono === "aviso" ? "aviso" : "info" };
    case "imagen": {
      const pct = numeroEn(raw.anchoPct, 10, 100);
      return {
        id: bid(), tipo: "imagen",
        archivo: normalizarArchivo(raw.archivo, (x) => id("archivo_imagen", x)),
        pie: textoONull(raw.pie, T.pieImagen),
        anchoPct: pct === null ? 100 : Math.round(pct),
      };
    }
    case "salto_pagina": return { id: bid(), tipo: "salto_pagina" };
    case "auto":
      if (!incluye(TIPOS_AUTO, raw.auto)) return null;
      return { id: bid(), tipo: "auto", auto: raw.auto, titulo: textoONull(raw.titulo, T.titulo), filasExtra: filasTabla(raw.filasExtra, TOPES_DOC.maxColumnas).map((f) => recortarVacias(f)), conContacto: bool(raw.conContacto, false) };
    default:
      return null;
  }
}

/** Una fila extra conserva solo hasta su última celda con texto (sus columnas las pone la tabla). */
function recortarVacias(f: string[]): string[] {
  let n = f.length;
  while (n > 0 && !f[n - 1]) n--;
  return f.slice(0, n);
}

function normalizarSeccion(raw: unknown, id: Ids): Seccion | null {
  if (!esObjeto(raw)) return null;
  return {
    id: id("seccion", raw.id),
    titulo: textoCorto(raw.titulo, T.titulo),
    activa: bool(raw.activa, true),
    numerada: bool(raw.numerada, true),
    bloques: lista(raw.bloques).map((b) => normalizarBloque(b, id)).filter((b): b is Bloque => !!b).slice(0, TOPES_DOC.maxBloquesSeccion),
  };
}

// ══ Paso 4 ═════════════════════════════════════════════════════════════════════

function roles<X extends string>(raw: unknown, todos: readonly X[]): X[] {
  const r = todos.filter((x) => lista(raw).includes(x));
  return r.length ? r : [...todos];
}

/** Una fuente de ítem del expediente válida, o null. */
export function normalizarFuente(raw: unknown, id: (x: unknown) => string): FuenteItem | null {
  if (!esObjeto(raw)) return null;
  switch (raw.tipo) {
    case "legajo":
      return incluye(CODIGOS_LEGAJO, raw.codigo) ? { tipo: "legajo", codigo: raw.codigo, documentoId: enteroEn(raw.documentoId, 1, Number.MAX_SAFE_INTEGER) } : null;
    case "docs_unidades":
      return incluye(DOCS_UNIDAD_LIC, raw.doc) ? { tipo: "docs_unidades", doc: raw.doc, roles: roles(raw.roles, ROLES_UNIDAD) } : null;
    case "fotos_unidades":
    case "fichas_unidades":
      return { tipo: raw.tipo, roles: roles(raw.roles, ROLES_UNIDAD) };
    case "docs_conductores":
      return incluye(CODIGOS_DOC_CONDUCTOR, raw.doc) ? { tipo: "docs_conductores", doc: raw.doc, roles: roles(raw.roles, ROLES_CONDUCTOR) } : null;
    case "cuadro_experiencia":
      return { tipo: "cuadro_experiencia" };
    case "sustentos_experiencia":
      return { tipo: "sustentos_experiencia", clase: incluye(SUSTENTOS, raw.clase) ? raw.clase : "todos" };
    case "seguro":
      return incluye(TIPOS_SEGURO_LIC, raw.seguro) ? { tipo: "seguro", seguro: raw.seguro } : null;
    case "adjunto":
      return { tipo: "adjunto", archivo: normalizarArchivo(raw.archivo, id) };
    case "tabla":
      return raw.tabla === "relacion_unidades" || raw.tabla === "relacion_conductores" || raw.tabla === "contactos" ? { tipo: "tabla", tabla: raw.tabla } : null;
    case "propuesta":
      return { tipo: "propuesta" };
    default:
      return null;
  }
}

function normalizarItem(raw: unknown, id: Ids): ItemExpediente | null {
  if (!esObjeto(raw)) return null;
  const fuente = normalizarFuente(raw.fuente, (x) => id("archivo_adjunto", x));
  if (!fuente) return null;
  return { id: id("item", raw.id), incluido: bool(raw.incluido, true), titulo: textoONull(raw.titulo, T.titulo), fuente };
}

function normalizarBloqueExp(raw: unknown, id: Ids): BloqueExpediente | null {
  if (!esObjeto(raw)) return null;
  return {
    id: id("bloque_expediente", raw.id),
    activo: bool(raw.activo, true),
    titulo: textoCorto(raw.titulo, T.titulo),
    subtitulo: textoCorto(raw.subtitulo, T.titulo),
    referencia: textoCorto(raw.referencia, T.referenciaBloque),
    conPortada: bool(raw.conPortada, true),
    items: lista(raw.items).map((i) => normalizarItem(i, id)).filter((i): i is ItemExpediente => !!i).slice(0, TOPES_DOC.maxItemsBloque),
  };
}

function normalizarFoliado(raw: unknown): OpcionesFoliado {
  const r = esObjeto(raw) ? raw : {};
  const formato = textoCorto(r.formato, T.formatoFolio);
  return {
    modo: r.modo === "descendente" || r.modo === "ninguno" ? r.modo : "ascendente",
    formato: formato.includes("{n}") ? formato : FOLIADO_DEFECTO.formato,
    digitos: enteroEn(r.digitos, 1, 6) ?? FOLIADO_DEFECTO.digitos,
    posicion: r.posicion === "superior_derecha" || r.posicion === "inferior_centro" ? r.posicion : "inferior_derecha",
    foliarPortadas: bool(r.foliarPortadas, FOLIADO_DEFECTO.foliarPortadas),
    foliarBloquesSueltos: bool(r.foliarBloquesSueltos, FOLIADO_DEFECTO.foliarBloquesSueltos),
  };
}

function normalizarExpediente(raw: unknown, id: Ids): Expediente {
  const r = esObjeto(raw) ? raw : {};
  return {
    bloques: lista(r.bloques).map((b) => normalizarBloqueExp(b, id)).filter((b): b is BloqueExpediente => !!b).slice(0, TOPES_DOC.maxBloquesExpediente),
    foliado: normalizarFoliado(r.foliado),
    propuestaEnCompleto: r.propuestaEnCompleto === "no" ? "no" : "primero",
  };
}

function normalizarAceptados(raw: unknown): HallazgoAceptado[] {
  const vistos = new Set<string>();
  const out: HallazgoAceptado[] = [];
  for (const a of lista(raw)) {
    if (!esObjeto(a)) continue;
    const clave = textoCorto(a.clave, T.clave);
    if (!clave || vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({ clave, nota: limpiarTexto(a.nota, T.nota), por: textoONull(a.por, T.corto), en: textoCorto(a.en, 40) });
    if (out.length >= T.maxAceptados) break;
  }
  return out;
}

const cadenas = (raw: unknown, max: number): string[] =>
  [...new Set(lista(raw).map((x) => textoCorto(x, T.clave)).filter(Boolean))].slice(0, max);

// ══ API ════════════════════════════════════════════════════════════════════════

/** Un documento vacío y válido. */
export function docVacio(nuevoId: () => string): DocLicitacion {
  return normalizarDoc({}, nuevoId);
}

/** El documento con forma válida (ver la cabecera). Idempotente; nunca lanza. */
export function normalizarDoc(raw: unknown, nuevoId: () => string): DocLicitacion {
  const r = esObjeto(raw) ? raw : {};
  const id = ids(nuevoId);
  const an = esObjeto(r.analisis) ? r.analisis : {};
  const glos = esObjeto(r.glosario) ? r.glosario : {};
  const ind = esObjeto(r.indice) ? r.indice : {};
  const copia = esObjeto(r.copiaDe) ? r.copiaDe : null;
  const copiaId = copia ? enteroEn(copia.licitacionId, 1, Number.MAX_SAFE_INTEGER) : null;
  return {
    esquema: ESQUEMA_DOC,
    bases: lista(r.bases).map((b) => {
      const a = normalizarArchivo(b, (x) => id("archivo_base", x));
      return a ? ({ ...a, tipo: esObjeto(b) && incluye(TIPOS_BASE, b.tipo) ? b.tipo : "otro" } as ArchivoBase) : null;
    }).filter((b): b is ArchivoBase => !!b).slice(0, T.maxBases),
    requisitos: lista(r.requisitos).map((q) => normalizarRequisito(q, id)).filter((q): q is Requisito => !!q).slice(0, TOPES_DOC.maxRequisitos),
    consultas: lista(r.consultas).map((c) => normalizarConsulta(c, id)).filter((c): c is ConsultaAbsuelta => !!c).slice(0, T.maxConsultas),
    analisis: {
      aplicadoId: enteroEn(an.aplicadoId, 1, Number.MAX_SAFE_INTEGER),
      aceptados: cadenas(an.aceptados, T.maxIdsAnalisis),
      descartados: cadenas(an.descartados, T.maxIdsAnalisis),
    },
    unidades: lista(r.unidades).map((u) => normalizarUnidad(u, id)).filter((u): u is UnidadElegida => !!u).slice(0, TOPES_DOC.maxUnidades),
    conductores: lista(r.conductores).map((c) => normalizarConductor(c, id)).filter((c): c is ConductorElegido => !!c).slice(0, TOPES_DOC.maxConductores),
    experiencia: normalizarExperiencia(r.experiencia),
    contactos: lista(r.contactos).map((c) => normalizarContacto(c, id)).filter((c): c is Contacto => !!c).slice(0, T.maxContactos),
    representante: normalizarRepresentante(r.representante, id),
    portada: normalizarPortada(r.portada, id),
    control: normalizarControl(r.control),
    carta: normalizarCarta(r.carta),
    glosario: {
      activo: bool(glos.activo, false),
      entradas: lista(glos.entradas).filter(esObjeto).slice(0, T.maxGlosario).map((e): EntradaGlosario => ({
        id: id("glosario", e.id), termino: textoCorto(e.termino, T.corto), definicion: limpiarTexto(e.definicion, T.definicion),
      })),
    },
    indice: { activo: bool(ind.activo, true), niveles: ind.niveles === 1 ? 1 : 2 },
    secciones: lista(r.secciones).map((s) => normalizarSeccion(s, id)).filter((s): s is Seccion => !!s).slice(0, TOPES_DOC.maxSecciones),
    cierre: normalizarCierre(r.cierre),
    expediente: normalizarExpediente(r.expediente, id),
    aceptados: normalizarAceptados(r.aceptados),
    copiaDe: copia && copiaId
      ? { licitacionId: copiaId, cliente_nombre: textoCorto(copia.cliente_nombre, T.titulo), codigo: textoONull(copia.codigo, 80) }
      : null,
  };
}

/** Bytes del documento tal como viaja al jsonb (para el tope de 3 MB). */
export function bytesDoc(doc: DocLicitacion): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

/**
 * Copia de un documento para OTRA licitación. Lo que se lleva y por qué:
 *  · el contenido (portada, control, carta, glosario, secciones, cierre) y la estructura del expediente;
 *  · con `conRecursos`, unidades, conductores, experiencia y contactos; el representante va siempre
 *    (es de la empresa, no del concurso);
 *  · con `conRequisitos`, los requisitos — con `origen: "copia"`, SIN su marca manual ni su cita (las dos
 *    hablan de las bases del OTRO concurso).
 * Lo que NO se lleva: las bases, las consultas absueltas y los adjuntos subidos (son del otro concurso:
 *  el ítem queda pendiente de subir), los datos de la carta que nombran al otro cliente, los hallazgos
 *  aceptados y el análisis IA. Todos los ids son nuevos. `copiaDe` nombra el origen para que la revisión
 *  detecte su cliente o su código si quedaron en el texto.
 */
export function duplicarDoc(origen: Licitacion, opts: { nuevoId: () => string; conRecursos: boolean; conRequisitos: boolean }): DocLicitacion {
  const o = normalizarDoc(origen.doc, opts.nuevoId);
  const nid = opts.nuevoId;
  const mapaBloques = new Map<string, string>();
  const archivo = (a: ArchivoRef | null): ArchivoRef | null => (a ? { ...a, id: nid() } : null);
  const bloques: BloqueExpediente[] = o.expediente.bloques.map((b) => {
    const nuevo = nid();
    mapaBloques.set(b.id, nuevo);
    return {
      ...b, id: nuevo,
      items: b.items.map((i): ItemExpediente => ({
        ...i, id: nid(),
        fuente: i.fuente.tipo === "adjunto" ? ({ tipo: "adjunto", archivo: null } as FuenteItem) : i.fuente,
      })),
    };
  });
  const bloque = (b: Bloque): Bloque => (b.tipo === "imagen" ? { ...b, id: nid(), archivo: archivo(b.archivo) } : { ...b, id: nid() });
  const copia: DocLicitacion = {
    ...o,
    bases: [],
    requisitos: opts.conRequisitos
      ? o.requisitos.map((q) => ({
          ...q, id: nid(), manual: null, cita: null, origen: "copia",
          bloqueExpedienteId: q.bloqueExpedienteId ? mapaBloques.get(q.bloqueExpedienteId) ?? null : null,
        }))
      : [],
    consultas: [],
    analisis: { aplicadoId: null, aceptados: [], descartados: [] },
    unidades: opts.conRecursos ? o.unidades.map((u) => ({ ...u, id: nid() })) : [],
    conductores: opts.conRecursos ? o.conductores.map((c) => ({ ...c, id: nid() })) : [],
    experiencia: opts.conRecursos ? { ...o.experiencia, ids: [...o.experiencia.ids] } : { ids: [], ventanaAnios: null, conContacto: false, introduccion: "" },
    contactos: opts.conRecursos ? o.contactos.map((c) => ({ ...c, id: nid() })) : [],
    representante: { ...o.representante, firma: archivo(o.representante.firma) },
    portada: { ...o.portada, imagen: archivo(o.portada.imagen) },
    control: { ...o.control, fecha: null },
    carta: { ...o.carta, lugarFecha: "", destinatario: "", atencion: "", referencia: "" },
    glosario: { ...o.glosario, entradas: o.glosario.entradas.map((e) => ({ ...e, id: nid() })) },
    secciones: o.secciones.map((s) => ({ ...s, id: nid(), bloques: s.bloques.map(bloque) })),
    expediente: { ...o.expediente, bloques },
    aceptados: [],
    copiaDe: { licitacionId: origen.id, cliente_nombre: textoCorto(origen.cliente_nombre, T.titulo), codigo: textoONull(origen.codigo, 80) },
  };
  return normalizarDoc(copia, nid);
}
