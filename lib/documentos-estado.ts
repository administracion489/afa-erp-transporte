// lib/documentos-estado.ts — ¿este servicio está documentalmente APTO? (motor PURO:
// sin React, sin DOM, sin fetch, sin BD; importable desde un cron de servidor).
//
// ══════════════════════════════════════════════════════════════════════════════
// PROBLEMA 1 · EL SEMÁFORO QUE SE PONE VERDE PORQUE LA BASE ESTÁ VACÍA
//
// app/seguimiento/page.tsx:189-192 decide si una unidad puede salir así:
//
//     docs.filter(d => d.vehiculo_id === vehiculoId && (diasPara(d.fecha_vencimiento) ?? 1) < 0)
//
// `diasPara(null)` devuelve null (misma página, :120-123) y el `?? 1` lo convierte en
// "le queda 1 día" = VIGENTE. O sea: un vehículo SIN NINGÚN documento cargado no produce
// ni una sola fila que filtrar, sale con la lista de vencidos vacía y se pinta VERDE.
// Un semáforo automático que dice APTO porque nadie llenó la ficha es PEOR que el chip
// manual `reservas.documentos_ok`: el chip al menos exige que un humano se haga cargo.
//
// La contramedida ya existía y estaba escrita —app/tercerizadas/page.tsx:181-183,
// `docsObligFaltantes()`, con su comentario "PUNTO CIEGO HISTÓRICO"— pero vivía dentro de
// un `"use client"` que ni el cron ni /seguimiento pueden importar. Aquí se trae, no se
// reinventa: se compara contra la LISTA DE OBLIGATORIOS, no contra las filas que existan.
//
// ══════════════════════════════════════════════════════════════════════════════
// PROBLEMA 2 · CINCO LISTAS DE "DOCUMENTOS OBLIGATORIOS" QUE NO COINCIDEN
//
//   1. app/documentos-vehiculares/page.tsx:26-40 — flota propia; 7 obligatorios
//      (incluye CAT y Tarjeta de Circulación, que nadie más pide).
//   2. app/tercerizadas/page.tsx:78-89        — terceros; 7 obligatorios
//      (incluye SCTR Salud y SCTR Pensión, que nadie más pide).
//   3. app/seguimiento/page.tsx:~166 y ~194   — 4 obligatorios, hardcodeados dos veces
//      en el mismo archivo.
//   4. app/programacion/page.tsx:367          — 4 obligatorios y **SIN TILDES**:
//        ["SOAT", "Revision Tecnica (CITV)", "Habilitacion SUTRAN", "Permiso Operacion MTC"]
//      Los datos en `documentos_tercero.tipo` SÍ llevan tildes ("Revisión Técnica (CITV)"),
//      así que ese `includes()` solo acierta con "SOAT". Tres de cuatro documentos
//      obligatorios eran invisibles para /programacion, en silencio, desde siempre.
//      → NADIE debe volver a comparar `tipo` con `===` / `includes()` sobre literales.
//        Para eso está `tipoCanonico()` más abajo: normaliza (sin tildes, minúsculas,
//        sin puntuación, espacios colapsados) y resuelve alias, de modo que
//        "Revision Tecnica", "Revisión Técnica (CITV)" y "CITV" son el MISMO documento.
//   5. lib/proveedor-documentos.ts:23         — copia de la (2) para el cron de avisos,
//      con su propio comentario admitiendo que es un duplicado a mantener a mano.
//
// ══════════════════════════════════════════════════════════════════════════════
// PROBLEMA 3 · SE CASTIGA A LA EMPRESA ENTERA POR UN DOCUMENTO DE OTRA UNIDAD
//
// `documentos_tercero` tiene `vehiculo_id`: NULL = documento general de la empresa,
// con valor = documento de ESA placa. app/tercerizadas/page.tsx:203 ya filtra bien:
//     d.vehiculo_id === null || d.vehiculo_id === veh.id
// pero /seguimiento ni siquiera trae la columna (page.tsx:41 — `type DocTer` no la tiene)
// y filtra solo por `empresa_id`: el SOAT vencido de la unidad B bloquea a la unidad A.
//
// ══════════════════════════════════════════════════════════════════════════════
// PROBLEMA 4 · SE EVALÚA CONTRA "HOY", NO CONTRA LA FECHA DEL SERVICIO
//
// Los cuatro `diasPara()` del repo hacen `... - Date.now()`. Para un servicio de dentro
// de tres semanas eso responde la pregunta equivocada: no importa si el SOAT está vigente
// HOY, importa si lo estará EL DÍA QUE EL BUS SALE. Aquí todo se mide contra
// `fechaServicio` y la aritmética es de CALENDARIO (ambas fechas ancladas al mediodía de
// Lima, UTC-5), nunca contra el reloj del equipo: una laptop en otra zona horaria movía
// un vencimiento un día entero, que es exactamente la diferencia entre "vence hoy" y
// "vencido". Misma disciplina que app/api/cliente/gps/route.ts:59-64 (`limaMs`).
//
// ══════════════════════════════════════════════════════════════════════════════
// DECISIONES DEL DUEÑO (2026-08-20), respetadas al pie de la letra:
//
//   · Documento obligatorio SIN CARGAR → ÁMBAR, avisa, **NO bloquea**. Solo bloquea el
//     documento que está cargado Y vencido. Razón: la BD viene a medio llenar de años de
//     operación; bloquear por ausencia dejaría media flota en tierra el primer día y el
//     semáforo se apagaría en una semana. Un aviso que nadie puede ignorar vale más que
//     un bloqueo que todo el mundo aprende a saltarse.
//   · Lo ÚNICO que bloquea es un documento cargado Y vencido: `bloquea ⇒ veredicto ===
//     "vencido"`, siempre, sin excepciones. El llamador nunca tiene que replicar la regla:
//     lee `bloquea` y ya.
//     La recíproca NO se cumple, y es deliberado (defecto [BAJA] :663-668): hay vencidos que
//     no detienen nada —un documento que no es exigible para salir (Seguro Todo Riesgo) o el
//     contrato laboral del conductor— y se emiten con `veredicto: "vencido"` y `bloquea:
//     false`. La versión anterior los disfrazaba de "por_vencer" para sostener la
//     equivalencia, y producía hallazgos ámbar con `diasRestantes: -257`: mentirle al campo
//     `veredicto` para salvar una frase del comentario. El veredicto describe el HECHO
//     (¿está vencido?); `bloquea`, la CONSECUENCIA (¿impide salir?). Son dos preguntas.
//
// ══════════════════════════════════════════════════════════════════════════════
// LO QUE ESTE MÓDULO NO HACE, DELIBERADAMENTE: no lee ni escribe en la base, no toca
// `reservas.documentos_ok`, no manda avisos y no impide nada por sí mismo. Devuelve un
// VEREDICTO; quién lo pinta, quién avisa y quién bloquea la salida se decide fuera.
// Misma doctrina de la casa que lib/avance-paradas.ts:30 —"inferir para PINTAR es otra
// cosa que inferir para ESCRIBIR"—: que el motor diga "no apto" NO autoriza a nadie a
// escribir `documentos_ok = false` sobre la decisión de un operador.
//
// NOTA sobre lib/retrasos.ts (el vecino, motor de PUNTUALIDAD): comparten filosofía
// (puro, veredicto con evidencia en texto, nada de escribir) pero cero código. Sus
// helpers `hhmmMin`/`minHhmm` trabajan con minutos del día y aquí no hay horas: la
// aptitud documental se resuelve por DÍA. Importarlos por importar sería acoplar dos
// motores sin ganar una línea.

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS PÚBLICOS
// ══════════════════════════════════════════════════════════════════════════════

export type VeredictoDoc = "vencido" | "por_vencer" | "sin_registro" | "conforme";

export type Sujeto = "unidad" | "conductor" | "empresa";

export type HallazgoDoc = {
  sujeto: Sujeto;
  /** "CNQ396", "Luis Q.", "GLOBAL BUS PERU" — lo que el operador reconoce de un vistazo */
  sujetoNombre: string;
  /** tipo CANÓNICO (con tildes, como está en la BD): "Revisión Técnica (CITV)" */
  tipo: string;
  veredicto: VeredictoDoc;
  fechaVencimiento: string | null;
  /** días desde la FECHA DEL SERVICIO hasta el vencimiento. Negativo = ya vencido. */
  diasRestantes: number | null;
  /**
   * ¿impide la salida? true SOLO si `veredicto === "vencido"` (decisión del dueño, ver
   * cabecera). Al revés no: hay vencidos que NO bloquean (documento no exigible, contrato
   * laboral del conductor). Para pintar el semáforo se lee ESTE campo, no el veredicto.
   */
  bloquea: boolean;
  /** línea lista para pintar: "SOAT de CNQ396 venció el 12 Ago (hace 8 días)" */
  texto: string;
};

export type AptitudServicio = {
  /** false SOLO si hay al menos un hallazgo que bloquea */
  apto: boolean;
  bloqueantes: HallazgoDoc[];
  /**
   * Todo lo que se muestra pero no detiene nada: por_vencer, sin_registro y los vencidos
   * que no son exigibles para salir (`veredicto: "vencido"` con `bloquea: false`). El
   * criterio de reparto es `bloquea`, no el veredicto.
   */
  avisos: HallazgoDoc[];
  /** cuántas exigencias se verificaron y salieron cargadas y vigentes */
  conformes: number;
  resumen: string;
};

export type ConfigDoc = {
  /** ventana de "por vencer", en días desde la fecha del servicio */
  avisoDias: number;
  /** ¿el contrato laboral vencido del conductor cuenta como exigencia? (ver más abajo) */
  incluirContratoConductor: boolean;
};

export const CONFIG_DOC_DEFAULT: ConfigDoc = {
  // 30 días: el mismo umbral que ya usan estadoDoc() en app/tercerizadas/page.tsx:98-104,
  // app/documentos-vehiculares/page.tsx:54-59 y lib/proveedor-documentos.ts:41-46. No se
  // reabre la discusión aquí: se unifica el número que la casa ya usa en tres sitios.
  avisoDias: 30,
  // El contrato de trabajo vencido (conductores.fecha_venc_contrato) es un incumplimiento
  // LABORAL (SUNAFIL), no una inhabilitación para conducir: un fiscalizador de SUTRAN en
  // carretera no lo pide. Meterlo por defecto convertiría un problema de RR.HH. en un
  // servicio detenido. Se deja apagado y disponible para quien quiera el tablero SUNAFIL
  // completo — y cuando se enciende SOLO avisa, porque nunca llega a "vencido"→bloquea
  // sin que alguien lo decida explícitamente. Ver DOCS_CONDUCTOR_PROPIO.
  incluirContratoConductor: false,
};

// ══════════════════════════════════════════════════════════════════════════════
// FORMA DE LOS DATOS DE ENTRADA
// Nombres de tabla/columna verificados con grep contra el repo, uno por uno. Lo que NO
// existe en la BD no aparece aquí: queda documentado como hueco, no inventado como campo.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Una fila de `documentos_vehiculo` (vehiculo_id, tipo, fecha_vencimiento) o de
 * `documentos_tercero` (empresa_id, vehiculo_id, tipo, fecha_vencimiento). Se aceptan las
 * dos con la misma forma porque comparten las columnas que importan; `vehiculo_id` es
 * opcional pero LEERLO ES OBLIGATORIO para terceros (ver PROBLEMA 3 en la cabecera).
 */
export type DocFila = {
  tipo: string;
  fecha_vencimiento?: string | null;
  /** documentos_tercero: NULL = documento general de la empresa; con valor = de esa placa */
  vehiculo_id?: number | null;
  empresa_id?: number | null;
};

export type UnidadDoc = {
  /** id en `vehiculos` (propia) o en `vehiculos_tercero` (tercerizada) */
  id: number;
  placa?: string | null;
  /** true → sus documentos viven en `documentos_tercero` y hay empresa detrás */
  tercerizada?: boolean;
};

/**
 * Conductor. Las columnas de vencimiento SOLO existen en `conductores` (flota propia) —
 * verificado en app/conductores/page.tsx:8-25 y app/api/alertas-flota/tick/route.ts:661.
 *
 * HUECO CONOCIDO: `conductores_tercero` (app/tercerizadas/page.tsx:36-41) tiene
 * únicamente `nombre, dni, licencia, categoria_licencia, vencimiento_licencia, telefono,
 * email, estado, pin_acceso, activo_app`. NO tiene sctr_*_venc, examen_medico_venc ni
 * psicosometrico_venc. Por eso a un conductor tercerizado se le evalúa SOLO la licencia:
 * emitir "SCTR sin registro" por una columna que no existe sería ruido garantizado en el
 * 100 % de los terceros. Ese control, para terceros, viaja por otra vía: `documentos_tercero`
 * tipo "SCTR Salud"/"SCTR Pensión", que sí se evalúan como documentos de la empresa.
 */
export type ConductorDoc = {
  id?: number | null;
  nombre?: string | null;
  /** true → viene de `conductores_tercero`: solo hay licencia */
  tercerizado?: boolean;
  vencimiento_licencia?: string | null;
  // Solo `conductores` (flota propia) de aquí para abajo:
  sctr_salud_venc?: string | null;
  sctr_pension_venc?: string | null;
  examen_medico_venc?: string | null;
  psicosometrico_venc?: string | null;
  fecha_venc_contrato?: string | null;
};

/**
 * Empresa tercerizada. Columnas verificadas en app/tercerizadas/page.tsx:13-21:
 * `razon_social, venc_autorizacion (Autorización MTC), venc_habilitacion (Habilitación
 * SUTRAN), estado`. Valores de `estado` observados en la UI (page.tsx:1982-1983):
 * "activo" | "inactivo" | "suspendido".
 */
export type EmpresaDoc = {
  id?: number | null;
  razon_social?: string | null;
  estado?: string | null;
  venc_autorizacion?: string | null;
  venc_habilitacion?: string | null;
};

export type EntradaAptitud = {
  /** "YYYY-MM-DD" del servicio. TODO se mide contra esta fecha, nunca contra hoy. */
  fechaServicio: string;
  /**
   * "YYYY-MM-DD" del día EN CURSO (calendario de Lima). Opcional; por defecto `fechaLima()`,
   * o sea el reloj del proceso.
   *
   * Existe por el defecto [MEDIA] :523: el docblock de `evaluarAptitud()` promete "puro y
   * determinista, se puede replicar en un cron sin sorpresas" y sin este campo era mentira —
   * la única llamada al reloj (`fechaLima()` sin argumento) vivía DENTRO del motor, así que
   * el mismo input daba "venció el 1 Ene (hace 365 días)" o "estará vencido el día del
   * servicio" según cuándo corriera, y no había forma de congelarlo para una prueba.
   *
   * Para qué se usa: SOLO para el TIEMPO VERBAL de los textos (pasado "venció" vs futuro
   * "estará vencido"). Ningún veredicto, ningún `bloquea` y ningún `conformes` dependen de
   * hoy — eso se mide contra `fechaServicio` y nada más. Pasarlo mal empeora la redacción,
   * jamás la decisión.
   *
   * Se añade al tipo de entrada en vez de como 2º parámetro de la función para no romper la
   * firma pública `evaluarAptitud(e)` de los llamadores que ya existen.
   */
  hoy?: string | null;
  unidad?: UnidadDoc | null;
  /**
   * Filas de documentos de la unidad SIN pre-filtrar:
   *   · unidad propia      → `documentos_vehiculo` (se filtra por vehiculo_id)
   *   · unidad tercerizada → `documentos_tercero` de la empresa (se aplica la regla
   *     vehiculo_id IS NULL OR vehiculo_id = unidad.id, la de app/tercerizadas:203)
   * Filtrar aquí dentro y no fuera es a propósito: fuera es donde se olvidó.
   */
  docsUnidad?: DocFila[] | null;
  conductor?: ConductorDoc | null;
  empresa?: EmpresaDoc | null;
  cfg?: Partial<ConfigDoc>;
};

// ══════════════════════════════════════════════════════════════════════════════
// CATÁLOGO ÚNICO DE TIPOS — la unión razonada de las cinco listas de la cabecera
// ══════════════════════════════════════════════════════════════════════════════

type ExigeEn = "propia" | "tercero" | "ambas";

type TipoDoc = {
  /** etiqueta canónica, exactamente como se guarda hoy en la BD (con tildes) */
  canonico: string;
  /** dónde es OBLIGATORIO; null = catalogado pero opcional (nunca genera "sin_registro") */
  exige: ExigeEn | null;
  /**
   * Grupo de EQUIVALENCIA: dos tipos del mismo grupo cubren la misma exigencia legal.
   * Basta que UNO esté cargado y vigente para dar el grupo por conforme.
   */
  grupo?: string;
  /** alias ya normalizados con normalizarTipoDoc(); el canónico se añade solo */
  alias?: string[];
  /**
   * El documento NO CADUCA por ley: exigirle una fecha de vencimiento es exigirle un dato
   * que no existe. Ver la nota de la Tarjeta de Propiedad (TIVE) en TIPOS_DOC_UNIDAD.
   * Consecuencia única y absoluta: **cargado ⇒ conforme**, con fecha o sin ella. Nunca
   * "vencido", nunca "por vencer", nunca "sin fecha". Lo que sí sigue faltando si no hay
   * fila es el documento mismo → "sin_registro", igual que cualquier otro obligatorio.
   */
  sinVencimiento?: true;
  /**
   * DE QUIÉN es el documento. Por defecto "unidad" (cuelga de una placa).
   *
   * "personal" son los seguros del TRABAJADOR —SCTR Salud, SCTR Pensión, Vida Ley—, que
   * viven en `documentos_tercero` solo porque `conductores_tercero` no tiene columnas para
   * ellos (ver el HUECO CONOCIDO en ConductorDoc). Estar guardados ahí no los vuelve
   * documentos del bus: **una placa no tiene SCTR**. Filtrando la unidad BUI-272, el ERP le
   * reclamaba "SCTR Salud" y "SCTR Pensión" como obligatorios sin registrar de ESA placa —
   * y no hay forma de cumplirlo, porque lo que se contrata es la póliza de las personas.
   * Un pendiente que no se puede cerrar es el que enseña a ignorar la lista de pendientes.
   */
  ambito?: "unidad" | "personal";
};

/**
 * Por qué la unión no es "todos los obligatorios de todas las listas":
 *
 *   · NÚCLEO (ambas): SOAT/CAT, Revisión Técnica (CITV), Tarjeta de Propiedad,
 *     Habilitación SUTRAN, Permiso Operación MTC. Es la intersección de lo que /seguimiento
 *     y /programacion ya bloqueaban más lo que ambas fichas coinciden en exigir.
 *   · SOLO PROPIA: Tarjeta de Circulación (la pide el municipio al titular; un tercero
 *     responde por la suya y no la carga en nuestro ERP).
 *   · SOLO TERCERO: SCTR Salud y SCTR Pensión. En flota propia esas coberturas se
 *     controlan en la ficha del CONDUCTOR (conductores.sctr_*_venc), no como documento del
 *     vehículo: exigirlas dos veces produciría un "sin registro" perpetuo e incorregible.
 *
 * SOAT y CAT comparten `grupo: "seguro_obligatorio"`: el CAT (AFOCAT) sustituye al SOAT
 * legalmente. Sin el grupo, toda unidad con SOAT saldría con "CAT sin registro" para
 * siempre — el tipo de aviso que enseña al operador a ignorar los avisos.
 */
export const TIPOS_DOC_UNIDAD: TipoDoc[] = [
  { canonico: "SOAT",                    exige: "ambas",   grupo: "seguro_obligatorio" },
  { canonico: "CAT",                     exige: "propia",  grupo: "seguro_obligatorio", alias: ["cat afocat", "afocat"] },
  // La variante SIN TILDES es literalmente el bug de app/programacion/page.tsx:367; entra
  // como alias para que ese texto, si alguien lo guardó así en la BD, se reconozca igual.
  { canonico: "Revisión Técnica (CITV)", exige: "ambas",   alias: ["revision tecnica citv", "revision tecnica", "citv"] },
  // TIVE · Tarjeta de Identificación Vehicular (la "tarjeta de propiedad" de toda la vida).
  // LA EMITE SUNARP Y NO TIENE FECHA DE VENCIMIENTO: acredita la titularidad inscrita en el
  // Registro de Propiedad Vehicular y vale mientras esa titularidad y las características
  // del vehículo no cambien. Se REEMPLAZA (duplicado por pérdida, cambio de placa o de
  // características, transferencia), que no es lo mismo que caducar: no hay renovación
  // periódica ni fecha que vigilar. Por eso `sinVencimiento` y por eso los alias incluyen
  // el nombre nuevo — la ficha impresa dice "Tarjeta de Identificación Vehicular" desde
  // 2010 y en el ERP se sigue tecleando de las dos formas.
  { canonico: "Tarjeta de Propiedad",    exige: "ambas",   sinVencimiento: true,
    alias: ["tarjeta propiedad", "tive", "tarjeta de identificacion vehicular", "tarjeta identificacion vehicular"] },
  // TUC · Tarjeta Única de Circulación. Es el nombre REAL del documento que el ERP venía
  // llamando "Habilitación SUTRAN": la habilitación vehicular no es un papel, es el estado
  // en el registro del MTC, y lo que se lleva en la unidad y se le enseña al fiscalizador es
  // la TUC. El nombre viejo queda de ALIAS —hay filas escritas así en `documentos_tercero` y
  // `documentos_vehiculo`— y `supabase/documentos-tuc-renombrar.sql` las pasa al nuevo; hasta
  // que esa migración corra, el alias es lo único que sostiene la lectura. No se borra ni
  // después: alguien lo va a volver a teclear como lo aprendió.
  { canonico: "Tarjeta Única de Circulación (TUC)", exige: "ambas",
    alias: ["habilitacion sutran", "sutran", "tuc", "tarjeta unica de circulacion",
            "tarjeta unica de circulacion tuc"] },
  // Habilitación Vehicular · la otorga el MTC, y en Lima y Callao la ATU para el transporte
  // urbano de su ámbito — de ahí el doble rótulo. El ERP la llamaba "Permiso Operación MTC",
  // que confunde dos cosas: el permiso/autorización es de la EMPRESA (una Resolución
  // Directoral) y la habilitación es de la UNIDAD dentro de esa autorización. Como esta fila
  // cuelga de un vehículo, el nombre correcto es el de la unidad. El viejo queda de alias,
  // igual que en la TUC, y la migración pasa las filas ya escritas.
  { canonico: "Habilitación Vehicular (MTC/ATU)", exige: "ambas",
    alias: ["permiso operacion mtc", "permiso mtc", "permiso de operacion mtc",
            "habilitacion vehicular", "habilitacion vehicular mtc", "habilitacion vehicular atu",
            "habilitacion vehicular mtc atu"] },
  // OJO, NO ES LA TUC: esta es la municipal, anual, del titular. Se deja aparte porque
  // alguien la catalogó aparte; si AFA decide que es la misma exigencia, se unen con un
  // `grupo` compartido, no borrando una de las dos.
  { canonico: "Tarjeta de Circulación",  exige: "propia",  alias: ["tarjeta circulacion"] },
  // ── Seguros del TRABAJADOR, no de la unidad (ver `ambito`) ──────────────────────────
  // Los tres protegen a la persona que conduce, y se contratan por planilla, no por placa.
  // Vida Ley faltaba: es tan obligatoria como las otras dos (Ley 26790 para el SCTR;
  // D. Leg. 688 para el seguro de vida, exigible desde el primer día de trabajo), y en el
  // ERP ya existía para la flota propia como `conductores.vida_ley_venc` — a los terceros
  // simplemente no se les pedía.
  { canonico: "SCTR Salud",              exige: "tercero", ambito: "personal" },
  { canonico: "SCTR Pensión",            exige: "tercero", ambito: "personal", alias: ["sctr pension"] },
  { canonico: "Vida Ley",                exige: "tercero", ambito: "personal",
    alias: ["vida ley", "seguro vida ley", "seguro de vida ley", "seguro de vida"] },
  // Catalogados pero NUNCA obligatorios: si están y están vencidos se reportan como aviso,
  // y si no están no se echan de menos.
  { canonico: "Certificado GNV",         exige: null },
  { canonico: "Certificado GLP",         exige: null },
  { canonico: "Seguro Todo Riesgo",      exige: null },
  { canonico: "Responsabilidad Civil",   exige: null },
  { canonico: "Otro",                    exige: null },
];

/** Exigencias del CONDUCTOR de flota propia (columnas de `conductores`, verificadas). */
const DOCS_CONDUCTOR_PROPIO: { campo: keyof ConductorDoc; label: string; opcional?: boolean }[] = [
  { campo: "vencimiento_licencia", label: "Licencia de conducir" },
  { campo: "sctr_salud_venc",      label: "SCTR Salud" },
  { campo: "sctr_pension_venc",    label: "SCTR Pensión" },
  { campo: "examen_medico_venc",   label: "Examen médico ocupacional" },
  { campo: "psicosometrico_venc",  label: "Certificado psicosométrico" },
  // Se añade solo con cfg.incluirContratoConductor (ver CONFIG_DOC_DEFAULT).
  { campo: "fecha_venc_contrato",  label: "Contrato de trabajo", opcional: true },
];

// `conductores` tiene además `antecedentes_venc` y `vida_ley_venc`, marcados NO obligatorios
// en app/conductores/page.tsx:60-61. No entran: este motor decide si el bus puede salir, no
// reemplaza al tablero SUNAFIL de /conductores.

// ══════════════════════════════════════════════════════════════════════════════
// NORMALIZACIÓN DE TIPOS — la pieza que arregla el bug de las tildes
// ══════════════════════════════════════════════════════════════════════════════

/**
 * "Revisión Técnica (CITV)" → "revision tecnica citv".
 * Sin tildes, en minúsculas, sin puntuación ni paréntesis, con los espacios colapsados.
 * Mismo espíritu que el `norm()` de app/tercerizadas/page.tsx:126-127, más el borrado de
 * puntuación: sin él "Revision Tecnica" y "Revisión Técnica (CITV)" seguirían siendo dos
 * documentos distintos, que es justo lo que hay que evitar.
 */
export function normalizarTipoDoc(s: string | null | undefined): string {
  return (s || "")
    .normalize("NFD")
    // Diacríticos combinantes U+0300–U+036F. Con ESCAPES de verdad y no con los caracteres
    // literales que había aquí (defecto [BAJA] :315-316: el comentario prometía escapes y el
    // volcado de bytes mostraba CC 80 … CD AF): así la clase sobrevive a un reencodeo del
    // archivo. La línea en blanco que partía la cadena .replace().toLowerCase() también se va.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CLAVES_TIPO: { tipo: TipoDoc; claves: string[] }[] = TIPOS_DOC_UNIDAD.map((t) => ({
  tipo: t,
  claves: [normalizarTipoDoc(t.canonico), ...(t.alias || [])].filter((c, i, a) => c && a.indexOf(c) === i),
}));

/**
 * Resuelve un `tipo` crudo de la BD al tipo del catálogo. Dos pasadas:
 *   1. coincidencia EXACTA con el canónico o un alias;
 *   2. coincidencia por PREFIJO en cualquier dirección ("revision tecnica" ⊂
 *      "revision tecnica citv", "soat 2026" ⊃ "soat"), que es como se ven los tipos
 *      tecleados a mano.
 * Si la pasada 2 encuentra MÁS DE UN candidato, devuelve null en vez de adivinar: un
 * documento mal clasificado en silencio es exactamente el fallo que este archivo viene a
 * cerrar. Devolver null significa "no catalogado", y un no catalogado nunca bloquea.
 */
export function tipoCanonico(tipoCrudo: string | null | undefined): TipoDoc | null {
  const n = normalizarTipoDoc(tipoCrudo);
  if (!n) return null;
  for (const c of CLAVES_TIPO) if (c.claves.includes(n)) return c.tipo;
  const cand = CLAVES_TIPO.filter((c) =>
    c.claves.some((k) => n.startsWith(k + " ") || k.startsWith(n + " ")),
  );
  return cand.length === 1 ? cand[0].tipo : null;
}

/**
 * Etiqueta CANÓNICA de un tipo tecleado, para pintar y para indexar los `Record<tipo, cfg>`
 * de las pantallas. Un tipo no catalogado se devuelve tal cual: inventarle un nombre sería
 * peor que mostrar lo que alguien escribió.
 *
 * Es lo que permite renombrar un documento sin migrar la base primero. "Habilitación SUTRAN"
 * son filas ya escritas en `documentos_tercero`/`documentos_vehiculo`; sin pasar por aquí,
 * el `TIPOS_DOC[d.tipo]` de cada pantalla no encontraría la clave nueva, caería a "Otro" y
 * el documento perdería su icono, su marca de OBLIGATORIO y su sitio en la completitud —
 * o sea, renombrar una etiqueta habría apagado un control legal en silencio.
 */
export function etiquetaTipoDoc(tipoCrudo: string | null | undefined): string {
  return tipoCanonico(tipoCrudo)?.canonico ?? (tipoCrudo || "");
}

/**
 * ¿Este documento NO CADUCA por ley? (hoy: solo la Tarjeta de Propiedad / TIVE.)
 *
 * ES LA ÚNICA DEFINICIÓN DEL HECHO en todo el ERP, y resuelve por `tipoCanonico()` a
 * propósito: las cinco listas de la cabecera guardan el tipo como texto tecleado, así que
 * comparar con `=== "Tarjeta de Propiedad"` volvería a dejar fuera "tarjeta de propiedad",
 * "TIVE" y la variante sin tildes — exactamente el bug de app/programacion/page.tsx:367,
 * pero al revés: en vez de callar una alerta verdadera, levantaría una falsa.
 *
 * Un tipo no catalogado devuelve false: sin saber qué documento es, lo prudente es seguir
 * pidiéndole la fecha.
 */
export function docSinVencimiento(tipo: string | null | undefined): boolean {
  return tipoCanonico(tipo)?.sinVencimiento === true;
}

/** ¿De quién es el documento? "unidad" (de la placa) o "personal" (del trabajador). */
export function ambitoTipoDoc(tipo: string | null | undefined): "unidad" | "personal" {
  return tipoCanonico(tipo)?.ambito ?? "unidad";
}

/**
 * Tipos obligatorios según el origen de la unidad (uno por grupo de equivalencia).
 *
 * `ambito` acota a los de la UNIDAD o a los del PERSONAL. Sin acotar salen los dos, que es
 * lo correcto para la empresa entera (el cron de avisos, el semáforo del proveedor) y lo
 * incorrecto para una placa: a un bus no se le puede reclamar el SCTR de nadie.
 */
export function tiposObligatorios(tercerizada: boolean, ambito?: "unidad" | "personal"): TipoDoc[] {
  const donde: ExigeEn = tercerizada ? "tercero" : "propia";
  return TIPOS_DOC_UNIDAD.filter((t) =>
    (t.exige === "ambas" || t.exige === donde) &&
    (!ambito || (t.ambito ?? "unidad") === ambito),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// FECHAS — calendario de Lima, no el reloj del equipo
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Instante de una fecha "YYYY-MM-DD" al MEDIODÍA de Lima (UTC-5, sin DST). El mediodía y
 * no la medianoche a propósito: deja 12 h de colchón a cada lado, así ningún desfase de
 * parsing puede correr una fecha al día vecino — que es la diferencia entre "vence hoy"
 * (vigente) y "vencido". Ancla equivalente a `limaMs()` en app/api/cliente/gps/route.ts:60-64.
 */
function mediodiaLimaMs(fecha: string | null | undefined): number | null {
  if (!fecha) return null;
  const f = String(fecha).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const t = Date.parse(`${f}T12:00:00-05:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Días de calendario de `desde` a `hasta` (ambas "YYYY-MM-DD"). Positivo = `hasta` es
 * posterior. Puro: no consulta el reloj. Sustituye a los cuatro `diasPara()` del repo, que
 * miden contra `Date.now()` y por tanto responden por HOY y no por el día del servicio.
 */
export function diasEntreFechas(desde: string, hasta: string | null | undefined): number | null {
  const a = mediodiaLimaMs(desde);
  const b = mediodiaLimaMs(hasta);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Fecha de calendario de Lima ("YYYY-MM-DD") de un instante dado. Conveniencia para el
 * llamador que necesita el "hoy" peruano (cron, servidor con reloj en UTC) sin volver a
 * escribir la resta de 5 h. Determinista si se le pasa `ms`; el default es lo único de
 * este archivo que mira el reloj, y solo porque alguien tiene que hacerlo.
 */
export function fechaLima(ms: number = Date.now()): string {
  const d = new Date(ms - 5 * 3600000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"];

/** "2026-08-12" → "12 Ago". Tabla fija y no `toLocaleDateString`: el locale del servidor
 *  no es el del operador, y aquí el texto va a un WhatsApp en español de Perú. */
function fechaCorta(f: string | null | undefined): string {
  const p = String(f || "").slice(0, 10).split("-");
  if (p.length !== 3) return "—";
  const mes = MESES[Number(p[1]) - 1];
  return mes ? `${Number(p[2])} ${mes}` : "—";
}

/** "2026-08-20" → "20/08/2026" (formato que ya usa la app en fmtFecha). */
function fechaDMY(f: string | null | undefined): string {
  const p = String(f || "").slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(f || "—");
}

const plural = (n: number, sing: string, pl: string) => `${n} ${n === 1 ? sing : pl}`;

// ══════════════════════════════════════════════════════════════════════════════
// EVALUACIÓN DE UNA EXIGENCIA
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Convierte una fecha de vencimiento en veredicto, medido contra la FECHA DEL SERVICIO.
 *
 *   dias < 0            → vencido      (BLOQUEA)
 *   0 <= dias <= aviso  → por_vencer   (avisa, NO bloquea)
 *   dias > aviso        → conforme
 *   sin fecha / sin fila→ sin_registro (avisa, decisión del dueño)
 *
 * `dias === 0` (vence el día EXACTO del servicio) → **por_vencer**, y por tanto NO bloquea.
 * El docblock anterior se contradecía a sí mismo en seis líneas: la tabla decía por_vencer y
 * el párrafo de abajo decía "es CONFORME" (defecto [BAJA] :422 vs :427). Se zanja a favor de
 * la tabla, que es lo que el código siempre hizo, y por la razón del negocio: un documento
 * vale hasta su fecha de vencimiento INCLUSIVE —así lo entiende SUTRAN—, así que el bus SÍ
 * puede salir ese día; lo que no puede es salir sin que nadie lo sepa. `conforme` lo dejaría
 * mudo (no entra a `avisos` y suma en `conformes`); `vencido` lo detendría sin derecho.
 * `por_vencer` es la única de las cuatro que dice la verdad: válido hoy, mañana no.
 * La tentación de escribir `dias <= 0 → vencido` sigue siendo un error: adelantaría un día
 * el vencimiento de toda unidad que renueva justo a tiempo.
 *
 * `permanente` es la excepción entera de la Tarjeta de Propiedad (ver `sinVencimiento`), y
 * SOLO se pasa true cuando la fila EXISTE: el documento está cargado y no caduca, así que
 * está conforme y `dias` es null porque no hay ninguna cuenta atrás que informar. Se decide
 * ANTES de leer la fecha —y no después— por la razón que sigue: si alguien tecleó una fecha
 * en un documento que por ley no vence, ese dato no significa nada, y dejarlo caducar
 * pintaría de rojo una unidad que está perfectamente en regla. Un rojo imposible de arreglar
 * es el que enseña a ignorar los rojos de verdad. No se puede colar nada por aquí: un
 * documento que no caduca no puede estar vencido.
 */
function evaluarFecha(
  fechaServicio: string,
  fechaVenc: string | null | undefined,
  avisoDias: number,
  permanente = false,
): { veredicto: VeredictoDoc; dias: number | null } {
  if (permanente) return { veredicto: "conforme", dias: null };
  const dias = diasEntreFechas(fechaServicio, fechaVenc);
  if (dias === null) return { veredicto: "sin_registro", dias: null };
  if (dias < 0) return { veredicto: "vencido", dias };
  if (dias <= avisoDias) return { veredicto: "por_vencer", dias };
  return { veredicto: "conforme", dias };
}

function hallazgo(
  sujeto: Sujeto,
  sujetoNombre: string,
  tipo: string,
  veredicto: VeredictoDoc,
  fechaVencimiento: string | null,
  dias: number | null,
  esFuturo: boolean,
): HallazgoDoc {
  const de = sujetoNombre ? ` de ${sujetoNombre}` : "";
  // El tiempo verbal se decide por la fecha del SERVICIO, no por hoy: para un servicio de
  // la semana que viene "venció" sería mentira; lo correcto es "estará vencido".
  let texto: string;
  if (veredicto === "vencido") {
    const d = Math.abs(dias ?? 0);
    texto = esFuturo
      ? `${tipo}${de} estará vencido el día del servicio (venció el ${fechaCorta(fechaVencimiento)})`
      : `${tipo}${de} venció el ${fechaCorta(fechaVencimiento)} (hace ${plural(d, "día", "días")})`;
  } else if (veredicto === "por_vencer") {
    const d = dias ?? 0;
    texto =
      d === 0
        ? `${tipo}${de} vence el mismo día del servicio (${fechaCorta(fechaVencimiento)})`
        : `${tipo}${de} vence el ${fechaCorta(fechaVencimiento)}, a ${plural(d, "día", "días")} del servicio`;
  } else if (veredicto === "sin_registro") {
    texto = fechaVencimiento
      ? `${tipo}${de} cargado sin fecha de vencimiento`
      : `${tipo}${de} sin cargar`;
  } else {
    // Conforme SIN fecha = el documento que no caduca (Tarjeta de Propiedad). "vigente hasta
    // el —" sería el guion que hace dudar de si falta el dato o falta el documento.
    texto = fechaVencimiento
      ? `${tipo}${de} vigente hasta el ${fechaCorta(fechaVencimiento)}`
      : `${tipo}${de} cargado (no vence)`;
  }
  return {
    sujeto,
    sujetoNombre,
    tipo,
    veredicto,
    fechaVencimiento: fechaVencimiento ?? null,
    diasRestantes: dias,
    bloquea: veredicto === "vencido",
    texto,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MOTOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Veredicto documental de UN servicio, contra su propia fecha. Puro y determinista:
 * mismas entradas, misma salida — se puede replicar en un cron sin sorpresas.
 *
 * "Determinista" ahora es verdad y no una aspiración: la ÚNICA lectura del reloj que tenía
 * el motor (`fechaLima()` sin argumento, defecto [MEDIA] :523) es el valor por defecto de
 * `e.hoy`. Pasa `hoy` y la salida queda congelada; omítelo y se comporta como antes.
 *
 * Lo que NO se hace y es deliberado: si falta la unidad o el conductor (servicio todavía
 * sin recursos asignados) esto NO devuelve "no apto". Un servicio sin bus no tiene
 * problema documental: tiene un problema de asignación, y confundir ambos llenaría la
 * torre de rojos que no se arreglan cargando papeles. Se reporta como aviso.
 */
export function evaluarAptitud(e: EntradaAptitud): AptitudServicio {
  const cfg = { ...CONFIG_DOC_DEFAULT, ...(e.cfg || {}) };
  const fechaServicio = String(e.fechaServicio || "").slice(0, 10);
  // "Hoy" se resuelve UNA sola vez y aquí arriba, antes de cualquier rama: es el único punto
  // del motor que puede mirar el reloj, y solo si el llamador no inyectó su propio día
  // (defecto [MEDIA] :523). Una fecha basura se ignora en silencio y cae al reloj: `hoy` solo
  // afecta al tiempo verbal del texto, así que abortar por él sería desproporcionado.
  const hoyStr = String(e.hoy || "").slice(0, 10);
  const hoy = /^\d{4}-\d{2}-\d{2}$/.test(hoyStr) ? hoyStr : fechaLima();
  const hallazgos: HallazgoDoc[] = [];
  let conformes = 0;

  // Sin fecha de servicio no hay contra qué medir. Se devuelve APTO con un aviso explícito
  // en vez de inventar "hoy": medir un servicio contra una fecha que no es la suya es el
  // PROBLEMA 4 de la cabecera, y no se arregla cometiéndolo aquí dentro.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaServicio)) {
    return {
      apto: true,
      bloqueantes: [],
      avisos: [
        {
          sujeto: "unidad", sujetoNombre: "", tipo: "Fecha del servicio",
          veredicto: "sin_registro", fechaVencimiento: null, diasRestantes: null,
          bloquea: false, texto: "Sin fecha de servicio: no se puede verificar la documentación",
        },
      ],
      conformes: 0,
      resumen: "Sin fecha de servicio · documentación no verificada",
    };
  }

  // `hoy` inyectable, NUNCA `fechaLima()` a pelo: es lo que hacía irreproducible al módulo.
  const esFuturo = (diasEntreFechas(hoy, fechaServicio) ?? 0) > 0;
  const push = (h: HallazgoDoc) => {
    if (h.veredicto === "conforme") conformes++;
    else hallazgos.push(h);
  };

  // ── 1 · EMPRESA TERCERIZADA ────────────────────────────────────────────────
  const emp = e.empresa || null;
  const empNombre = emp?.razon_social || "el proveedor";
  if (emp) {
    // `estado` es la única "fecha" que no es fecha. Suspendido/inactivo es una decisión
    // ADMINISTRATIVA ya tomada por alguien de la casa (app/tercerizadas/page.tsx:196-197
    // ya lo trata como riesgo alto): si el proveedor está suspendido, no sale. Se emite
    // como veredicto "vencido" para no abrir una quinta categoría solo por esto: abrirla
    // obligaría a cada pantalla a aprender un color nuevo, y "vencido + bloquea" ya dice
    // exactamente lo que hay que saber (no sale).
    const est = (emp.estado || "").trim().toLowerCase();
    if (est === "suspendido" || est === "inactivo") {
      hallazgos.push({
        sujeto: "empresa", sujetoNombre: empNombre, tipo: "Estado del proveedor",
        veredicto: "vencido", fechaVencimiento: null, diasRestantes: null,
        bloquea: true,
        texto: `${empNombre} está ${est === "suspendido" ? "suspendido" : "inactivo"} como proveedor`,
      });
    }
    // Habilitaciones propias de la EMPRESA (columnas verificadas en tercerizadas:19).
    for (const h of [
      { label: "Autorización MTC", f: emp.venc_autorizacion },
      { label: "Habilitación SUTRAN (empresa)", f: emp.venc_habilitacion },
    ]) {
      const r = evaluarFecha(fechaServicio, h.f, cfg.avisoDias);
      push(hallazgo("empresa", empNombre, h.label, r.veredicto, h.f ?? null, r.dias, esFuturo));
    }
  }

  // ── 2 · UNIDAD ─────────────────────────────────────────────────────────────
  const uni = e.unidad || null;
  const uniNombre = uni?.placa || (uni ? `unidad #${uni.id}` : "");
  if (!uni) {
    hallazgos.push({
      sujeto: "unidad", sujetoNombre: "", tipo: "Unidad asignada",
      veredicto: "sin_registro", fechaVencimiento: null, diasRestantes: null,
      bloquea: false, texto: "Servicio sin unidad asignada: documentación sin verificar",
    });
  } else {
    const tercerizada = !!uni.tercerizada;

    // EL FILTRO POR UNIDAD (PROBLEMA 3). Para terceros: documentos generales de la empresa
    // (vehiculo_id NULL) + los de ESTA placa. Regla copiada de app/tercerizadas/page.tsx:203,
    // no reinventada. Para flota propia `documentos_vehiculo.vehiculo_id` siempre apunta a
    // la unidad, así que el filtro es directo.
    // Una sola expresión para los dos orígenes, y no un ternario con las dos ramas iguales:
    // en `documentos_vehiculo` el vehiculo_id siempre apunta a la unidad (nunca NULL), así
    // que la rama "NULL = general de la empresa" es inofensiva ahí y necesaria en terceros.
    // La guarda `!!d` no es paranoia de estilo: este motor se importa desde crons, donde la
    // entrada viene de un `select` sin más filtro y una fila nula tumbaba el tick ENTERO con
    // `TypeError: Cannot read properties of null`. Un documento ilegible se ignora; el servicio
    // se sigue evaluando (y si ese tipo era obligatorio, cae solo en "sin registro").
    const aplican = (e.docsUnidad || []).filter(
      (d) => !!d && (d.vehiculo_id == null || d.vehiculo_id === uni.id),
    );

    // Índice tipo canónico → filas. Un mismo tipo puede tener varias filas (renovaciones
    // acumuladas): se toma la de vencimiento MÁS LEJANO, que es la vigente. Quedarse con la
    // primera haría que renovar el SOAT sin borrar el anterior dejara la unidad "vencida".
    const porTipo = new Map<string, DocFila[]>();
    const sueltos: DocFila[] = [];
    for (const d of aplican) {
      const t = tipoCanonico(d.tipo);
      if (!t) { sueltos.push(d); continue; }
      const arr = porTipo.get(t.canonico);
      if (arr) arr.push(d); else porTipo.set(t.canonico, [d]);
    }
    const mejorDe = (filas: DocFila[]): DocFila =>
      filas.reduce((a, b) => {
        const da = diasEntreFechas(fechaServicio, a.fecha_vencimiento);
        const db = diasEntreFechas(fechaServicio, b.fecha_vencimiento);
        if (da === null) return db === null ? a : b;
        if (db === null) return a;
        return db > da ? b : a;
      });

    // Se recorre la LISTA DE OBLIGATORIOS, no las filas existentes: aquí es donde muere el
    // "verde por base vacía" (PROBLEMA 1). Un tipo sin fila produce `sin_registro`, no un
    // silencio.
    const obligatorios = tiposObligatorios(tercerizada);

    // Las exigencias se agrupan ANTES de evaluar: un grupo de equivalencia (SOAT/CAT) es UNA
    // exigencia con dos formas de cumplirla, no dos exigencias.
    //
    // La primera versión evaluaba tipo por tipo y marcaba el grupo como resuelto sobre la
    // marcha. La prueba de humo la tumbó: con SOAT vencido y CAT vigente hasta 2028 el
    // veredicto salía NO APTO, porque SOAT se evaluaba primero y ya había emitido su
    // bloqueo cuando el CAT aparecía. Un vehículo con AFOCAT vigente SÍ está asegurado;
    // bloquearlo es el mismo tipo de falso positivo que este archivo viene a eliminar,
    // solo que en la otra dirección.
    const exigencias: TipoDoc[][] = [];
    const gruposVistos = new Set<string>();
    for (const t of obligatorios) {
      if (!t.grupo) { exigencias.push([t]); continue; }
      if (gruposVistos.has(t.grupo)) continue;
      gruposVistos.add(t.grupo);
      // Todos los miembros del grupo, incluso los que aquí no serían obligatorios: si el
      // CAT no se le exige a un tercero pero lo tiene cargado y vigente, cumple igual.
      exigencias.push(TIPOS_DOC_UNIDAD.filter((x) => x.grupo === t.grupo));
    }

    // Bondad de un veredicto entre miembros PRESENTES del grupo (menor = mejor).
    // "sin_registro" solo aparece si NINGÚN miembro está cargado: si el único presente está
    // vencido, el grupo está vencido y bloquea — no se lo degrada a "sin cargar".
    const RANK: Record<VeredictoDoc, number> = { conforme: 0, por_vencer: 1, sin_registro: 2, vencido: 3 };

    for (const grupo of exigencias) {
      type Cand = { canon: string; v: VeredictoDoc; f: string | null; dias: number | null };
      const presentes: Cand[] = [];
      for (const t of grupo) {
        const filas = porTipo.get(t.canonico);
        if (!filas || !filas.length) continue;
        const f = mejorDe(filas);
        // `!!t.sinVencimiento` va aquí dentro, donde ya consta que la fila EXISTE: un
        // documento que no caduca está conforme por estar cargado. Sin fila el flujo sigue
        // igual y cae en el `sin_registro` de abajo — que no caduque no lo hace opcional.
        const r = evaluarFecha(fechaServicio, f.fecha_vencimiento, cfg.avisoDias, !!t.sinVencimiento);
        presentes.push({ canon: t.canonico, v: r.veredicto, f: f.fecha_vencimiento ?? null, dias: r.dias });
      }
      // A QUIÉN se le reclama. Los seguros del trabajador (SCTR, Vida Ley) viven en
      // `documentos_tercero` por falta de columnas en `conductores_tercero`, pero son de la
      // EMPRESA: rotularlos con la placa producía "SCTR Salud de BUI-272 sin cargar", un
      // pendiente imposible de cerrar desde la ficha de esa unidad. El grupo entero comparte
      // ámbito (los de equivalencia son todos de unidad), así que basta mirar al primero.
      const esPersonal = (grupo[0].ambito ?? "unidad") === "personal";
      const suj: Sujeto = esPersonal ? "empresa" : "unidad";
      const sujNombre = esPersonal ? empNombre : uniNombre;

      if (!presentes.length) {
        // Aquí muere el "verde por base vacía": la ausencia se REPORTA, no se calla.
        // Se nombra el miembro principal del grupo (el primero del catálogo).
        push(hallazgo(suj, sujNombre, grupo[0].canonico, "sin_registro", null, null, esFuturo));
        continue;
      }
      presentes.sort((a, b) => RANK[a.v] - RANK[b.v] || (b.dias ?? -9999) - (a.dias ?? -9999));
      const mejor = presentes[0];
      push(hallazgo(suj, sujNombre, mejor.canon, mejor.v, mejor.f, mejor.dias, esFuturo));
    }

    // Documentos NO obligatorios que están cargados y vencidos: se reportan como AVISO
    // (nunca bloquean). Un Seguro Todo Riesgo vencido no detiene el bus, pero el operador
    // que lo ve a tiempo evita una discusión con el cliente después del siniestro.
    // Se excluyen los ya evaluados arriba mirando las EXIGENCIAS, no `obligatorios`: el CAT
    // de un tercero no es obligatorio pero sí entró al grupo del seguro, y contarlo aquí lo
    // reportaría dos veces.
    const yaEvaluados = new Set(exigencias.flat().map((t) => t.canonico));
    for (const [canon, filas] of porTipo) {
      if (yaEvaluados.has(canon)) continue;
      // Hoy ningún tipo `sinVencimiento` es opcional, así que todos salen por `yaEvaluados`
      // y esta guarda nunca se dispara. Va igual: el día que se catalogue uno opcional, sin
      // ella una fecha vieja tecleada en un documento que no caduca reaparecería como aviso
      // de vencido justo por la puerta de al lado.
      const f = mejorDe(filas);
      const r = evaluarFecha(fechaServicio, f.fecha_vencimiento, cfg.avisoDias, docSinVencimiento(canon));
      if (r.veredicto !== "vencido") continue;
      // El veredicto se queda en "vencido" y lo que se degrada es `bloquea`, no la verdad.
      // Antes se emitía como "por_vencer" con `diasRestantes` NEGATIVO (defecto [BAJA]
      // :663-668: Seguro Todo Riesgo vencido 2026-01-01 → {por_vencer, -257}), y cualquier
      // pantalla que agrupe o coloree por `veredicto` —VEREDICTO_DOC_CFG le da ámbar "Por
      // vencer"— recibía un dato que contradecía a su propio campo de días. Un vencido es
      // vencido; que no sea obligatorio cambia la CONSECUENCIA (no detiene el bus), no el
      // hecho. El texto sigue diciendo "(no obligatorio)" para que se lea por qué no bloquea.
      hallazgos.push({
        ...hallazgo("unidad", uniNombre, canon, "vencido", f.fecha_vencimiento ?? null, r.dias, esFuturo),
        bloquea: false,
        texto: `${canon} de ${uniNombre} vencido el ${fechaCorta(f.fecha_vencimiento)} (no obligatorio)`,
      });
    }
    // `sueltos` (tipos que no resuelven a nada del catálogo, p. ej. "Otro" mal escrito) se
    // ignoran a propósito: no se puede afirmar nada de un documento que no sabemos qué es.
    void sueltos;
  }

  // ── 3 · CONDUCTOR ──────────────────────────────────────────────────────────
  const con = e.conductor || null;
  if (!con) {
    hallazgos.push({
      sujeto: "conductor", sujetoNombre: "", tipo: "Conductor asignado",
      veredicto: "sin_registro", fechaVencimiento: null, diasRestantes: null,
      bloquea: false, texto: "Servicio sin conductor asignado: documentación sin verificar",
    });
  } else {
    const nom = (con.nombre || "").trim() || "el conductor";
    // Tercerizado: SOLO licencia. Ver el HUECO CONOCIDO documentado en ConductorDoc.
    const lista = con.tercerizado
      ? DOCS_CONDUCTOR_PROPIO.filter((d) => d.campo === "vencimiento_licencia")
      : DOCS_CONDUCTOR_PROPIO.filter((d) => !d.opcional || cfg.incluirContratoConductor);
    for (const d of lista) {
      const f = (con[d.campo] as string | null | undefined) ?? null;
      const r = evaluarFecha(fechaServicio, f, cfg.avisoDias);
      const h = hallazgo("conductor", nom, d.label, r.veredicto, f, r.dias, esFuturo);
      // El contrato laboral nunca bloquea aunque esté vencido (ver CONFIG_DOC_DEFAULT). Se
      // baja `bloquea` y NO el veredicto, por la misma razón que el bloque de documentos no
      // obligatorios de arriba (defecto [BAJA] :663-668): reescribir "vencido"→"por_vencer"
      // dejaba un hallazgo ámbar con `diasRestantes` negativo, incoherente consigo mismo.
      push(d.opcional && h.veredicto === "vencido" ? { ...h, bloquea: false } : h);
    }
  }

  // ── 4 · CIERRE ─────────────────────────────────────────────────────────────
  // Más vencido primero; los "sin fecha" (dias null) al final de su grupo. Es el orden en
  // que el operador quiere leerlos: lo que impide salir arriba.
  const porUrgencia = (a: HallazgoDoc, b: HallazgoDoc) =>
    (a.diasRestantes ?? 9999) - (b.diasRestantes ?? 9999);

  const bloqueantes = hallazgos.filter((h) => h.bloquea).sort(porUrgencia);
  const avisos = hallazgos.filter((h) => !h.bloquea).sort(porUrgencia);
  const apto = bloqueantes.length === 0;

  let resumen: string;
  if (!apto) {
    resumen = bloqueantes.length === 1
      ? bloqueantes[0].texto
      : `${bloqueantes[0].texto} · y ${plural(bloqueantes.length - 1, "bloqueo más", "bloqueos más")}`;
  } else if (avisos.length) {
    // Se cuenta POR VEREDICTO y no por resta. Con la resta, todo aviso que no fuera
    // "sin_registro" caía en el cubo "por vencer", incluidos los vencidos que no bloquean
    // (documento no obligatorio, contrato del conductor): el resumen decía "1 por vencer" de
    // algo que llevaba 257 días vencido (defecto [BAJA] :663-668).
    const faltan = avisos.filter((h) => h.veredicto === "sin_registro").length;
    const vencidosSinBloqueo = avisos.filter((h) => h.veredicto === "vencido").length;
    const proximos = avisos.filter((h) => h.veredicto === "por_vencer").length;
    resumen = [
      faltan ? `${plural(faltan, "documento sin cargar", "documentos sin cargar")}` : null,
      vencidosSinBloqueo
        ? `${plural(vencidosSinBloqueo, "vencido no exigido", "vencidos no exigidos")}`
        : null,
      proximos ? `${plural(proximos, "por vencer", "por vencer")}` : null,
      `${conformes} al día para el ${fechaDMY(fechaServicio)}`,
    ].filter(Boolean).join(" · ");
  } else {
    resumen = `Documentos al día · ${plural(conformes, "verificado", "verificados")} para el ${fechaDMY(fechaServicio)}`;
  }

  return { apto, bloqueantes, avisos, conformes, resumen };
}

// ══════════════════════════════════════════════════════════════════════════════
// PRESENTACIÓN — una sola paleta para torre, drawer, portal y avisos
// Mismos colores que ESTADO_DOC_CFG en app/tercerizadas/page.tsx:135-140, para que un
// documento vencido se vea igual en las dos pantallas.
// ══════════════════════════════════════════════════════════════════════════════

export const VEREDICTO_DOC_CFG: Record<VeredictoDoc, { label: string; corto: string; color: string; bg: string; orden: number }> = {
  vencido:      { label: "Vencido",      corto: "VENCIDO",   color: "#991b1b", bg: "#fee2e2", orden: 1 },
  sin_registro: { label: "Sin cargar",   corto: "SIN DOC",   color: "#854d0e", bg: "#fef9c3", orden: 2 },
  por_vencer:   { label: "Por vencer",   corto: "POR VENCER", color: "#854d0e", bg: "#fef9c3", orden: 3 },
  conforme:     { label: "Vigente",      corto: "VIGENTE",   color: "#166534", bg: "#dcfce7", orden: 4 },
};

/** Semáforo de una línea para la torre: rojo bloquea, ámbar avisa, verde libre. */
export function nivelAptitud(a: AptitudServicio): "bloqueo" | "aviso" | "ok" {
  if (!a.apto) return "bloqueo";
  return a.avisos.length ? "aviso" : "ok";
}
