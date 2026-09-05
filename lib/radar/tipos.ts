// lib/radar/tipos.ts — Tipos compartidos del módulo Radar IA (cliente y servidor, sin dependencias).
//
// El Radar IA monitorea grupos de WhatsApp vía un worker externo (radar-worker/, Baileys)
// que inserta mensajes crudos en radar_mensajes. El pipeline del ERP (lib/radar/motor.ts)
// los clasifica con ELIA, extrae datos estructurados y ejecuta acciones por categoría.
// Esquema de BD: supabase/radar-ia.sql. Es un módulo INDEPENDIENTE del CRM/Meta oficial.

// ── Categorías ─────────────────────────────────────────────────────────────

export type CategoriaRadar =
  | "oportunidad_comercial"
  | "combustible"
  | "odometro"
  | "mantenimiento"
  | "operaciones"
  | "incidencias"
  | "documentacion"
  | "cobranza"
  | "otros";

export const CATEGORIAS_RADAR: Record<
  CategoriaRadar,
  { label: string; emoji: string; color: string; bg: string }
> = {
  oportunidad_comercial: { label: "Oportunidad", emoji: "💼", color: "#1d4ed8", bg: "#dbeafe" },
  combustible:           { label: "Combustible", emoji: "⛽", color: "#B07A0F", bg: "#FBF1D8" },
  odometro:              { label: "Odómetro", emoji: "🛞", color: "#0891b2", bg: "#cffafe" },
  mantenimiento:         { label: "Mantenimiento", emoji: "🔧", color: "#7c3aed", bg: "#ede9fe" },
  operaciones:           { label: "Operaciones", emoji: "🚌", color: "#0f766e", bg: "#ccfbf1" },
  incidencias:           { label: "Incidencia", emoji: "⚠️", color: "#b91c1c", bg: "#fee2e2" },
  documentacion:         { label: "Documentación", emoji: "📄", color: "#334155", bg: "#e2e8f0" },
  cobranza:              { label: "Cobranza", emoji: "💰", color: "#27AE60", bg: "#E8F5EC" },
  otros:                 { label: "Otros", emoji: "💬", color: "#5B6B82", bg: "#eef2f7" },
};

export const LISTA_CATEGORIAS = Object.keys(CATEGORIAS_RADAR) as CategoriaRadar[];

// ── Filas de BD ────────────────────────────────────────────────────────────

export type EstadoConexionRadar = "desconectado" | "esperando_qr" | "conectado";

export type RadarEstado = {
  id: number;
  estado: EstadoConexionRadar;
  qr_data_url: string | null;
  numero: string | null;
  detalle: string | null;
  version_worker: string | null;
  conectado_desde: string | null;
  ultimo_latido: string | null;
  /** El dashboard la prende con el botón "Generar QR nuevo"; el worker la apaga apenas la atiende. */
  solicitar_relink: boolean;
  /** Igual, para el botón "Actualizar lista" de la pestaña Grupos. */
  solicitar_sync_grupos?: boolean;
  /** Última lectura EXITOSA de la lista de grupos de WhatsApp (null si nunca se logró). */
  grupos_sincronizados_en?: string | null;
  updated_at: string;
};

export type RadarGrupo = {
  id: string;
  wa_group_id: string;
  nombre: string;
  participantes: number;
  activo: boolean;
  /** Nota del operador sobre qué es este grupo (se inyecta en los prompts de ELIA). */
  contexto: string | null;
  /** Restringe qué categorías aplican para ESTE grupo; null = usa las globales de radar_config. */
  categorias_permitidas: CategoriaRadar[] | null;
  /**
   * ¿El número conectado HOY ve este grupo? `false` = quedó de un número anterior, así que
   * por más que esté `activo` no puede llegar ni un mensaje. Opcional porque las filas
   * anteriores a supabase/radar-ia-grupos-vigencia.sql no la traen: **trátala siempre como
   * `g.visible !== false`**, nunca como `!g.visible` (undefined significa "no se sabe", y
   * dar por no visible todo lo antiguo pintaría la lista entera de advertencias).
   */
  visible?: boolean;
  /** Última vez que el worker vio este grupo en la lista de WhatsApp. */
  visto_en?: string | null;
  created_at: string;
  updated_at: string;
};

export type TipoMensajeRadar = "texto" | "imagen" | "documento" | "audio" | "video" | "otro";
export type EstadoMensajeRadar = "pendiente" | "procesando" | "procesado" | "descartado" | "error" | "fusionado";

export type RadarMensaje = {
  id: string;
  wa_message_id: string;
  grupo_id: string | null;
  wa_group_id: string | null;
  grupo_nombre: string | null;
  remitente_wa: string | null;
  remitente_nombre: string | null;
  tipo: TipoMensajeRadar;
  texto: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_nombre: string | null;
  transcripcion: string | null;
  ts_mensaje: string;
  recibido_en: string;
  estado: EstadoMensajeRadar;
  categoria: CategoriaRadar | null;
  confianza: number | null;
  resumen_ia: string | null;
  resultado: Record<string, unknown> | null;
  accion: string | null;
  error: string | null;
  feedback: "correcto" | "incorrecto" | null;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number;
  procesado_en: string | null;
};

export type RadarOportunidad = {
  id: string;
  mensaje_id: string | null;
  estado: "nueva" | "revisada" | "cotizada" | "descartada";
  fecha_servicio: string | null;
  hora_servicio: string | null;
  ciudad: string | null;
  distrito: string | null;
  origen: string | null;
  destino: string | null;
  pasajeros: number | null;
  tipo_vehiculo: string | null;
  unidades: number | null;
  tiempo_espera: string | null;
  servicios_adicionales: string | null;
  cliente_nombre: string | null;
  empresa: string | null;
  telefono: string | null;
  observaciones: string | null;
  cliente_id: number | null;
  disponibilidad: DisponibilidadOportunidad | null;
  precio_referencial: number | null;
  utilidad_estimada: number | null;
  probabilidad: number | null;
  cotizacion_id: number | null;
  /** Cuántas veces se detectó el mismo pedido (mismo remitente, ruta y fecha) en distintos grupos/mensajes. */
  veces_detectada: number;
  /** Rastro de en qué grupos/mensajes se vio este mismo pedido (para mostrar "visto en N grupos"). */
  grupos_json: { grupo_nombre: string | null; mensaje_id: string; recibido_en: string }[];
  created_at: string;
};

export type DisponibilidadOportunidad = {
  vehiculos_libres: number;
  vehiculos_tipo: number | null; // libres del tipo pedido (null si no se pidió tipo)
  conductores_libres: number;
  servicios_ese_dia: number;
  detalle: string;
};

export type RadarCombustible = {
  id: string;
  mensaje_id: string | null;
  estado: "registrado" | "pendiente_revision" | "descartado";
  placa: string | null;
  vehiculo_id: number | null;
  vehiculo_tercero_id: number | null;
  fecha: string | null;
  hora: string | null;
  grifo: string | null;
  direccion_grifo: string | null;
  tipo_combustible: string | null;
  galones: number | null;
  litros: number | null;
  precio_galon: number | null;
  precio_litro: number | null;
  monto_total: number | null;
  comprobante: string | null;
  kilometraje: number | null;
  conductor: string | null;
  proveedor: string | null;
  anomalias: AnomaliaCombustible[];
  /** Fotos que la IA procesó (voucher/surtidor/tablero): [{ url, mime, nombre }]. Vacío en filas viejas. */
  fotos: RadarFoto[] | null;
  combustible_id: number | null;
  created_at: string;
};

export type RadarFoto = {
  url: string;
  mime: string | null;
  nombre: string | null;
};

export type AnomaliaCombustible = {
  codigo:
    | "galones_exceden_tanque"
    | "posible_duplicado"
    | "precio_fuera_de_rango"
    | "km_menor_al_actual"
    | "consumo_excesivo"
    | "recarga_madrugada"
    | "monto_inconsistente"
    | "galones_coinciden_km"
    // Multi-foto / reconciliación (camino de visión):
    | "marca_kit_como_grifo"          // grifo/proveedor era una marca de kit GLP del tablero (LANDI RENZO…)
    | "tasa_como_cantidad"            // "16.3 L/100km" (tasa) registrado como galones
    | "trip_como_odometro"           // el "Trip"/viaje parcial registrado como odómetro total
    | "discrepancia_maquina_vs_nota" // surtidor/display difiere de la nota (informativo: manda la nota)
    | "voucher_no_leido"             // había foto de nota/surtidor pero no se pudo leer la cantidad/importe
    | "multiples_recargas_en_cluster" // la ráfaga trae 2 recargas/comprobantes distintos
    // Cuadre aritmético del voucher (lib/radar/coherencia-voucher.ts):
    | "lectura_corregida"            // cantidad × precio = total identificó el dígito mal leído y se corrigió
    | "cuadre_ambiguo"               // no cuadra y más de una lectura lo explicaría: no se tocó nada
    | "dato_derivado"                // faltaba uno de los tres números y se calculó de los otros dos
    | "cantidad_no_coincide_texto";  // el número extraído contradice la transcripción literal de la IA
  detalle: string;
  /** false = observación informativa (NO bloquea el auto-registro). Ausente o true = bloqueante. */
  bloquea?: boolean;
  /**
   * Qué número cambió el cuadre aritmético, en estructurado. Existe para que la pantalla y el
   * dataset de lecciones NO tengan que olfatear el texto de `detalle`: `valor_ia` de una
   * corrección humana posterior es `leido`, no lo que quedó guardado en la fila.
   */
  correccion?: {
    campo: "cantidad" | "precio" | "monto";
    /** Lo que leyó la IA. null = el campo faltaba y se derivó. */
    leido: number | null;
    corregido: number;
    /** Si la cantidad se guardó en litros y no en galones (para nombrar el campo). */
    unidad?: string | null;
  };
};

export type SeveridadAlerta = "critico" | "atencion" | "info";

export type RadarAlerta = {
  id: string;
  mensaje_id: string | null;
  tipo: string;
  severidad: SeveridadAlerta;
  titulo: string;
  detalle: string | null;
  href: string | null;
  leida: boolean;
  created_at: string;
};

export type RadarConfig = {
  id: number;
  activo: boolean;
  horario_activo: boolean;
  hora_inicio: string; // "HH:MM" hora Lima
  hora_fin: string;
  categorias_activas: CategoriaRadar[];
  acciones_automaticas: { combustible?: boolean; odometro?: boolean; mantenimiento?: boolean; operaciones?: boolean };
  palabras_clave: string[];
  umbral_confianza: number;
  modelo_triage: string;
  modelo_extraccion: string;
  notificar_email: boolean;
  correos_alerta: string | null;
  limite_diario_usd: number;
  /** Cómo leer los vouchers de grifo (peculiaridades del formato) — se inyecta en la extracción con visión. */
  guia_voucher: string | null;
  updated_at: string;
};

// ── Extracciones de ELIA por categoría (todo nullable: "si no está, null, no inventes") ──

export type ResultadoTriage = {
  categoria: CategoriaRadar;
  confianza: number; // 0..1
  resumen: string;   // una línea en español
};

export type ExtraccionOportunidad = {
  fecha: string | null;        // YYYY-MM-DD ya resuelta ("mañana" → fecha real Lima)
  hora: string | null;         // HH:MM 24h
  ciudad: string | null;
  distrito: string | null;
  origen: string | null;
  destino: string | null;
  pasajeros: number | null;
  tipo_vehiculo: string | null; // AUTO|SUV|VAN|MINIBUS|BUS|CUSTER si se puede mapear
  unidades: number | null;
  tiempo_espera: string | null;
  servicios_adicionales: string | null;
  cliente: string | null;
  empresa: string | null;
  telefono: string | null;
  observaciones: string | null;
};

export type ExtraccionCombustible = {
  placa: string | null;        // normalizada AAA-123 / ABC123 mayúsculas
  unidad: string | null;       // referencia informal ("bus 45")
  fecha: string | null;        // YYYY-MM-DD
  hora: string | null;
  grifo: string | null;
  direccion_grifo: string | null;
  tipo_combustible: string | null; // diesel|gasolina|glp|gnv|urea|biodiesel
  galones: number | null;
  litros: number | null;
  precio_galon: number | null;
  precio_litro: number | null;
  monto_total: number | null;
  comprobante: string | null;
  kilometraje: number | null;
  conductor: string | null;
  proveedor: string | null;
  // ── Campos adicionales del camino de VISIÓN multi-foto (opcionales; el camino de texto no los llena) ──
  ruc?: string | null;                 // RUC impreso en la nota de despacho
  consumo_l_100km?: number | null;     // TASA de consumo del viaje (p.ej. 16.3) — informativo, NUNCA cantidad cargada
  trip_km?: number | null;             // cuentakm PARCIAL del tablero — informativo, NO es el odómetro total
  vio_nota?: boolean | null;           // se vio una foto de nota/comprobante de grifo
  vio_surtidor?: boolean | null;       // se vio una foto del surtidor
  vio_tablero?: boolean | null;        // se vio una foto del tablero/odómetro
  fuentes?: Record<string, string | null> | null;          // de qué foto salió cada campo clave (galones→surtidor, etc.)
  confianza_campos?: Record<string, number | null> | null; // 0..1 por campo clave
  discrepancias?: string[] | null;     // p.ej. "surtidor 8.548 gal vs nota 8.55 gal"
  notas_extraccion?: string | null;    // dudas de 7 segmentos, fotos ilegibles, etc.
  /**
   * Los dígitos de la cantidad TAL CUAL están impresos ("8.799x"), sin interpretar. Espejo de
   * `texto_leido` en ExtraccionOdometro y por el mismo motivo: transcribir obliga a mirar las
   * cifras en vez de estimar el número, y deja una SEGUNDA lectura del mismo dato con la que
   * el ERP puede contrastar la primera (ver lib/radar/coherencia-voucher.ts).
   */
  texto_cantidad?: string | null;
};

/**
 * Solo un reporte de kilometraje, SIN datos de compra (sin monto/grifo/galones) — el
 * conductor solo informa el odómetro. Si el mensaje trae también datos de una recarga,
 * es "combustible" en cambio, no "odometro" (ver DESCRIPCION_CATEGORIAS en prompts.ts).
 */
export type ExtraccionOdometro = {
  placa: string | null;
  unidad: string | null;
  kilometraje: number | null;
  trip_km: number | null;
  fecha: string | null;
  hora: string | null;
  conductor: string | null;
  calidad_imagen: "buena" | "regular" | "mala" | null;
  confianza_lectura: number | null;
  texto_leido: string | null;
  observaciones: string | null;
};

export type ExtraccionMantenimiento = {
  placa: string | null;
  unidad: string | null;
  tipo_trabajo: string | null;  // aceite|neumaticos|frenos|reparacion|soat|revision_tecnica|otro
  tipo: "preventivo" | "correctivo" | null;
  descripcion: string | null;
  taller: string | null;
  costo: number | null;
  fecha: string | null;
  urgente: boolean | null;      // la unidad no puede operar
};

export type ExtraccionOperacion = {
  placa: string | null;
  unidad: string | null;
  evento: "llego" | "inicio" | "finalizo" | "abordo" | "retraso" | "cancelacion" | "otro" | null;
  detalle: string | null;
  hora: string | null;
};

export type ExtraccionDocumentacion = {
  tipo_documento: string | null; // SOAT|Licencia|Revisión Técnica (CITV)|Póliza|Permiso|otro
  placa: string | null;
  conductor: string | null;
  fecha_vencimiento: string | null; // YYYY-MM-DD
  detalle: string | null;
};

export type ExtraccionIncidencia = {
  placa: string | null;
  unidad: string | null;
  tipo_incidencia: string | null; // choque|averia|robo|reclamo|accidente|otro
  gravedad: "alta" | "media" | "baja" | null;
  detalle: string | null;
};

export type ExtraccionCobranza = {
  cliente: string | null;
  empresa: string | null;
  monto: number | null;
  factura: string | null;
  detalle: string | null;
};

export type ExtraccionRadar =
  | ExtraccionOportunidad
  | ExtraccionCombustible
  | ExtraccionMantenimiento
  | ExtraccionOperacion
  | ExtraccionDocumentacion
  | ExtraccionIncidencia
  | ExtraccionCobranza
  | Record<string, unknown>;

// ── Contratos del pipeline (implementados en lib/radar/motor.ts y acciones.ts) ──

/** Resultado de ejecutar la acción de una categoría sobre un mensaje ya extraído. */
export type ResultadoAccion = {
  accion: string;                       // slug de lo que pasó (p.ej. "combustible_registrado")
  detalle: string;                      // una línea en español para el feed
  datos?: Record<string, unknown>;      // ids creados, anomalías, etc.
};

/** Resumen que devuelve procesarPendientes() (lo consumen /api/radar/procesar y el cron). */
export type ResumenProcesamiento = {
  procesados: number;
  descartados: number;
  errores: number;
  omitidos: number;   // fuera de horario / presupuesto agotado: quedan pendientes
  costo_usd: number;
};
