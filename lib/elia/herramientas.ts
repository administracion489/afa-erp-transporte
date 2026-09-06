// ============================================================
// ELIA — Herramientas del motor (SOLO servidor).
// Cada herramienta consulta datos REALES de Supabase con service-role,
// pero solo se expone a Claude si el usuario tiene permiso del módulo.
// Devuelve: JSON para el modelo + (opcional) un bloque visual para el panel.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { etiquetaEstado, etiquetaAdmin } from "@/lib/estados";
import { docSinVencimiento, etiquetaTipoDoc, tiposObligatorios } from "@/lib/documentos-estado";
import { seriesRendimiento, juzgarTramo } from "@/lib/rendimiento";
import type {
  BloqueUI,
  ServicioUI,
  VehiculoUI,
  ConductorUI,
  KpiUI,
  RankingUI,
  RadarItem,
} from "./tipos";

export const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export type SB = ReturnType<typeof db>;

export type CtxElia = {
  sb: SB;
  permisos: string[];
  rol: string;
  nombreUsuario: string;
};

// ── Fechas Perú (UTC-5 fijo, sin DST) ───────────────────────────────────────
export function fechaLima(offsetDias = 0): string {
  const ms = Date.now() - 5 * 3600 * 1000 + offsetDias * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
export function horaLima(): string {
  const lima = new Date(Date.now() - 5 * 3600 * 1000);
  return lima.toISOString().slice(11, 16);
}
const diasPara = (f?: string | null): number | null =>
  f ? Math.ceil((new Date(f + "T00:00:00-05:00").getTime() - Date.now()) / 86400000) : null;

/** Primer día del mes, `meses` hacia atrás incluyendo el actual (1 = mes en curso). */
function inicioMeses(meses: number): string {
  const hoy = fechaLima();
  const total = Number(hoy.slice(0, 4)) * 12 + (Number(hoy.slice(5, 7)) - 1) - (meses - 1);
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

/** "HH:MM[:SS]" → minutos desde medianoche (null si no parsea). */
const minutosDe = (h?: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Recorre una consulta paginada contra el corte de 1000 filas de Supabase. */
async function fetchPaginado(consulta: (desde: number, hasta: number) => any, maxPaginas = 5): Promise<any[]> {
  const filas: any[] = [];
  for (let p = 0; p < maxPaginas; p++) {
    const { data } = await consulta(p * 1000, p * 1000 + 999);
    const lote = (data as any[]) ?? [];
    filas.push(...lote);
    if (lote.length < 1000) break;
  }
  return filas;
}

/** Monto compacto para etiquetas de gráfico: "S/ 45.2k". */
const fmtCorto = (n: number) =>
  Math.abs(n) >= 10000 ? `S/ ${(n / 1000).toFixed(1)}k` : "S/ " + Math.round(n).toLocaleString("es-PE");

const MES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];

const fmtSoles = (n: number) =>
  "S/ " + Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const tienePermiso = (ctx: { permisos: string[]; rol: string }, modulos: string[]) =>
  ctx.rol === "admin" || modulos.some((m) => ctx.permisos.includes(m));

const puedeVerPrecios = (ctx: { permisos: string[]; rol: string }) =>
  tienePermiso(ctx, ["facturacion", "reportes", "cotizaciones", "gastos"]);

// Documentos vehiculares obligatorios (mismo criterio que documentos-vehiculares).
// Se comparan SIEMPRE contra `etiquetaTipoDoc(tipo)`: en la base el tipo es texto tecleado
// y hay filas con el nombre viejo ("Habilitación SUTRAN", "Permiso Operación MTC").
const DOCS_OBLIGATORIOS = new Set([
  "SOAT",
  "Revisión Técnica (CITV)",
  "Tarjeta de Propiedad",
  "Tarjeta Única de Circulación (TUC)",
  "Tarjeta de Circulación",
  // La Habilitación Vehicular NO va aquí: es UNA de la empresa, y de ella salen las TUC de
  // cada vehículo. Se vigila en la ficha del proveedor, no por placa.
]);

// ── Rutas navegables (espejo de menuGrupos en app/layout.tsx) ───────────────
export const RUTAS_MODULO: { href: string; etiqueta: string; modulo: string; alias: string[] }[] = [
  { href: "/dashboard", etiqueta: "Dashboard", modulo: "dashboard", alias: ["dashboard", "panel", "inicio", "resumen"] },
  { href: "/cotizaciones", etiqueta: "Cotizaciones", modulo: "cotizaciones", alias: ["cotizaciones", "cotizacion", "precios"] },
  { href: "/cotizador", etiqueta: "Cotizador", modulo: "cotizaciones", alias: ["cotizador", "costos"] },
  { href: "/tarifario", etiqueta: "Tarifas", modulo: "tarifas", alias: ["tarifas", "tarifario"] },
  { href: "/clientes", etiqueta: "Clientes", modulo: "clientes", alias: ["clientes", "cliente", "base comercial"] },
  { href: "/crm", etiqueta: "Inbox CRM", modulo: "crm", alias: ["crm", "inbox", "conversaciones", "whatsapp"] },
  { href: "/crm/pipeline", etiqueta: "Pipeline CRM", modulo: "crm", alias: ["pipeline", "embudo", "leads"] },
  { href: "/crm/agente", etiqueta: "Agente IA del CRM", modulo: "crm", alias: ["agente ia", "afita", "agente crm"] },
  { href: "/cotizaciones/plantillas", etiqueta: "Plantillas PDF", modulo: "cotizaciones", alias: ["plantillas", "plantillas pdf"] },
  { href: "/mantenimiento/planes", etiqueta: "Planes Fabricante", modulo: "mantenimiento", alias: ["planes fabricante", "plan de mantenimiento"] },
  { href: "/despachador", etiqueta: "Despachador", modulo: "despachador", alias: ["despachador", "despacho", "urgentes"] },
  { href: "/calendario", etiqueta: "Calendario", modulo: "dashboard", alias: ["calendario", "agenda"] },
  { href: "/programacion", etiqueta: "Programación", modulo: "programacion", alias: ["programacion", "reservas", "servicios"] },
  { href: "/seguimiento", etiqueta: "Seguimiento", modulo: "seguimiento", alias: ["seguimiento", "torre de control", "estado"] },
  { href: "/monitoreo", etiqueta: "Monitoreo", modulo: "monitoreo", alias: ["monitoreo", "mapa", "gps", "en vivo"] },
  { href: "/pasajeros", etiqueta: "Pasajeros", modulo: "pasajeros", alias: ["pasajeros", "pasajero"] },
  { href: "/multas", etiqueta: "Multas", modulo: "multas", alias: ["multas", "infracciones", "papeletas"] },
  { href: "/incidencias", etiqueta: "Incidencias", modulo: "incidencias", alias: ["incidencias", "eventos", "alertas"] },
  { href: "/vehiculos", etiqueta: "Vehículos", modulo: "vehiculos", alias: ["vehiculos", "flota", "unidades"] },
  { href: "/documentos-vehiculares", etiqueta: "Docs. Vehiculares", modulo: "vehiculos", alias: ["documentos vehiculares", "soat", "citv", "revision tecnica"] },
  { href: "/mantenimiento", etiqueta: "Mantenimiento", modulo: "mantenimiento", alias: ["mantenimiento", "taller", "ot", "odometro"] },
  { href: "/neumaticos", etiqueta: "Neumáticos", modulo: "neumaticos", alias: ["neumaticos", "llantas"] },
  { href: "/combustible", etiqueta: "Combustible", modulo: "combustible", alias: ["combustible", "grifo", "petroleo", "gasolina"] },
  { href: "/seguros", etiqueta: "Seguros", modulo: "seguros", alias: ["seguros", "polizas", "sctr"] },
  { href: "/conductores", etiqueta: "Conductores", modulo: "conductores", alias: ["conductores", "choferes", "conductor"] },
  { href: "/personal-administrativo", etiqueta: "Personal Adm.", modulo: "personal-administrativo", alias: ["personal", "administrativo", "rrhh"] },
  { href: "/proveedores", etiqueta: "Proveedores", modulo: "proveedores", alias: ["proveedores", "talleres", "grifos"] },
  { href: "/tercerizadas", etiqueta: "Tercerizadas", modulo: "proveedores", alias: ["tercerizadas", "terceros", "flota externa"] },
  { href: "/facturacion", etiqueta: "Facturación", modulo: "facturacion", alias: ["facturacion", "facturas", "sunat", "cobranza", "por cobrar"] },
  { href: "/gastos", etiqueta: "Gastos", modulo: "gastos", alias: ["gastos", "egresos"] },
  { href: "/vencimientos", etiqueta: "Vencimientos", modulo: "vencimientos", alias: ["vencimientos"] },
  { href: "/documentos", etiqueta: "Documentos", modulo: "documentos", alias: ["documentos", "sst", "contratos"] },
  { href: "/reportes", etiqueta: "Reportes", modulo: "reportes", alias: ["reportes", "indicadores", "kpi"] },
  { href: "/configuracion/usuarios", etiqueta: "Usuarios", modulo: "usuarios", alias: ["usuarios", "permisos"] },
  { href: "/configuracion/elia", etiqueta: "Configuración de ELIA", modulo: "configuracion", alias: ["configurar elia", "limite de elia", "presupuesto de elia", "gasto de elia"] },
  { href: "/configuracion/perfil", etiqueta: "Perfil Empresa", modulo: "configuracion", alias: ["perfil", "perfil empresa", "logo"] },
  { href: "/configuracion/costos", etiqueta: "Costos", modulo: "ajustes", alias: ["costos", "parametros de costo"] },
  { href: "/configuracion/sistema", etiqueta: "Sistema", modulo: "configuracion", alias: ["sistema", "parametros", "configuracion"] },
];

export const TODOS_LOS_MODULOS = [...new Set(RUTAS_MODULO.map((r) => r.modulo))];

// ── Definición de herramientas ───────────────────────────────────────────────
// Qué módulos habilitan cada herramienta (basta con tener uno).
const MODULOS_TOOL: Record<string, string[]> = {
  resumen_operativo: ["dashboard"],
  buscar_servicios: ["programacion", "seguimiento", "despachador", "dashboard"],
  detalle_servicio: ["programacion", "seguimiento", "despachador", "dashboard"],
  consultar_flota: ["vehiculos", "mantenimiento", "dashboard"],
  consultar_conductores: ["conductores"],
  consultar_clientes: ["clientes", "crm", "cotizaciones"],
  ranking_clientes: ["reportes", "facturacion", "clientes", "crm"],
  analisis_combustible: ["combustible", "gastos", "reportes"],
  finanzas: ["facturacion", "gastos", "reportes"],
  rentabilidad: ["reportes", "facturacion"],
  desempeno_conductores: ["conductores", "reportes", "seguimiento"],
  utilizacion_flota: ["vehiculos", "reportes", "programacion"],
  analisis_cotizaciones: ["cotizaciones", "reportes", "crm"],
  ocupacion_servicios: ["programacion", "seguimiento", "pasajeros", "reportes"],
  tendencia_mensual: ["reportes", "facturacion"],
  consultar_multas: ["multas", "reportes", "vehiculos"],
  consultar_incidencias: ["incidencias", "reportes", "seguimiento"],
  consultar_neumaticos: ["neumaticos", "vehiculos", "mantenimiento"],
  consultar_seguros: ["seguros", "vehiculos", "reportes"],
  consultar_mantenimiento: ["mantenimiento", "vehiculos"],
  buscar_pasajero: ["pasajeros", "programacion", "seguimiento"],
  consultar_tercerizadas: ["proveedores", "vehiculos", "reportes"],
  consultar_personal: ["personal-administrativo"],
  consultar_documentos_empresa: ["documentos", "vencimientos"],
  consultar_proveedores: ["proveedores"],
  uso_de_elia: ["configuracion", "usuarios"],
  gps_en_vivo: ["monitoreo", "seguimiento"],
  abrir_modulo: [], // siempre disponible; valida permisos por destino
  proponer_accion: ["programacion", "despachador"],
};

// Etiqueta amigable que ve el usuario mientras la herramienta corre.
export const ETIQUETA_TOOL: Record<string, string> = {
  resumen_operativo: "Revisando cómo va el día…",
  buscar_servicios: "Buscando servicios…",
  detalle_servicio: "Abriendo el detalle del servicio…",
  consultar_flota: "Revisando la flota y sus documentos…",
  consultar_conductores: "Revisando a los conductores…",
  consultar_clientes: "Consultando la cartera de clientes…",
  ranking_clientes: "Armando el ranking de clientes…",
  analisis_combustible: "Analizando el consumo de combustible…",
  finanzas: "Haciendo números…",
  rentabilidad: "Calculando la rentabilidad real…",
  desempeno_conductores: "Revisando el desempeño de los conductores…",
  utilizacion_flota: "Midiendo el uso de la flota…",
  analisis_cotizaciones: "Analizando las cotizaciones…",
  ocupacion_servicios: "Midiendo la ocupación de los servicios…",
  tendencia_mensual: "Trazando la tendencia del negocio…",
  consultar_multas: "Revisando las multas…",
  consultar_incidencias: "Revisando las incidencias…",
  consultar_neumaticos: "Revisando los neumáticos…",
  consultar_seguros: "Revisando las pólizas de seguro…",
  consultar_mantenimiento: "Revisando el mantenimiento…",
  buscar_pasajero: "Buscando al pasajero…",
  consultar_tercerizadas: "Evaluando a las empresas tercerizadas…",
  consultar_personal: "Revisando al personal administrativo…",
  consultar_documentos_empresa: "Revisando los documentos de la empresa…",
  consultar_proveedores: "Buscando en proveedores…",
  uso_de_elia: "Revisando mi propio consumo…",
  gps_en_vivo: "Mirando el mapa en vivo…",
  abrir_modulo: "Preparando el acceso directo…",
  proponer_accion: "Preparando la acción…",
};

const TOOLS_DEF: any[] = [
  {
    name: "resumen_operativo",
    description:
      "Foto del día: cuántos servicios hay hoy y en qué estado, más el radar de avisos (documentos por vencer, licencias, cobranzas, SOS). Úsala cuando pregunten '¿cómo vamos?', '¿qué hay hoy?', o al inicio para dar contexto.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "buscar_servicios",
    description:
      "Busca servicios/reservas por fecha (o rango), estado, cliente, placa o texto de origen/destino. Sin filtros devuelve los de HOY. Úsala para '¿qué servicios hay mañana?', 'los viajes de [cliente]', '¿qué tiene programado la placa X?'.",
    input_schema: {
      type: "object",
      properties: {
        fecha_desde: { type: "string", description: "YYYY-MM-DD (por defecto hoy)" },
        fecha_hasta: { type: "string", description: "YYYY-MM-DD (por defecto igual a fecha_desde)" },
        estado: {
          type: "string",
          enum: ["pendiente", "programada", "confirmada", "en_curso", "finalizada", "cancelada"],
        },
        cliente_nombre: { type: "string", description: "Nombre o empresa del cliente (búsqueda parcial)" },
        placa: { type: "string", description: "Placa del vehículo (propio o tercero)" },
        texto: { type: "string", description: "Texto libre a buscar en origen/destino" },
      },
    },
  },
  {
    name: "detalle_servicio",
    description:
      "Detalle completo de UN servicio por su ID: itinerario de paradas, ocupación de pasajeros, asignación de unidad/conductor y gastos registrados. Úsala cuando ya identificaste el servicio.",
    input_schema: {
      type: "object",
      properties: { reserva_id: { type: "integer" } },
      required: ["reserva_id"],
    },
  },
  {
    name: "consultar_flota",
    description:
      "Estado de TODA la flota (propia y tercerizada): disponibilidad, semáforo documentario, kilometraje y próximo mantenimiento. Para unidades propias los documentos (SOAT, CITV, SUTRAN, MTC…) son por vehículo; para las tercerizadas, por la EMPRESA dueña. Con solo_alertas=true devuelve únicamente unidades con problemas.",
    input_schema: {
      type: "object",
      properties: {
        placa: { type: "string", description: "Filtrar por placa (parcial)" },
        flota: { type: "string", enum: ["propia", "terceros", "toda"], description: "Por defecto 'toda'." },
        solo_alertas: { type: "boolean", description: "Solo unidades con documentos vencidos/por vencer o mantenimiento próximo" },
      },
    },
  },
  {
    name: "consultar_conductores",
    description:
      "Conductores propios Y de empresas tercerizadas: disponibilidad y vencimientos. Propios: licencia, SCTR, examen médico, psicosométrico, antecedentes, vida ley. Terceros: licencia. Con solo_alertas=true devuelve solo los que tienen documentos vencidos o por vencer.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Filtrar por nombre (parcial)" },
        flota: { type: "string", enum: ["propia", "terceros", "toda"], description: "Por defecto 'toda'." },
        solo_alertas: { type: "boolean" },
      },
    },
  },
  {
    name: "consultar_clientes",
    description:
      "Busca un cliente y devuelve sus datos de contacto y su actividad: servicios de este mes vs. el mes pasado (crecimiento o caída). Úsala para '¿cómo va [cliente]?' o antes de proponer seguimiento comercial.",
    input_schema: {
      type: "object",
      properties: { nombre: { type: "string", description: "Nombre o empresa (parcial)" } },
      required: ["nombre"],
    },
  },
  {
    name: "ranking_clientes",
    description:
      "Ranking de clientes por ventas, margen (ganancia) o número de servicios en los últimos N meses. Úsala para '¿qué cliente nos deja más ganancias?', 'top 5 clientes del trimestre', '¿quién nos compra más?'.",
    input_schema: {
      type: "object",
      properties: {
        criterio: {
          type: "string",
          enum: ["ventas", "margen", "servicios"],
          description: "Por defecto 'ventas'. 'margen' = ganancia neta por cliente.",
        },
        meses: { type: "integer", description: "Meses hacia atrás incluyendo el actual (1-12, por defecto 1 = mes en curso)" },
        top: { type: "integer", description: "Cuántos clientes devolver (por defecto 5, máximo 10)" },
      },
    },
  },
  {
    name: "analisis_combustible",
    description:
      "Analiza el consumo de combustible de los últimos N meses: ranking por conductor o por vehículo (gasto, cantidad, rendimiento km/gal) y PATRONES INUSUALES para revisar (cargas que superan la capacidad del tanque, rendimiento muy por debajo del promedio del propio vehículo, kilometraje que no avanza, dobles cargas el mismo día). Úsala para '¿quién consume más combustible?', '¿hay cargas sospechosas?', 'rendimiento de la placa X'.",
    input_schema: {
      type: "object",
      properties: {
        agrupar: { type: "string", enum: ["conductor", "vehiculo"], description: "Por defecto 'conductor'." },
        meses: { type: "integer", description: "Meses hacia atrás incluyendo el actual (1-12, por defecto 1)" },
        placa: { type: "string", description: "Analizar solo un vehículo (placa parcial)" },
      },
    },
  },
  {
    name: "finanzas",
    description:
      "Números del negocio. tipo='por_cobrar': facturas emitidas/enviadas/vencidas y servicios por liquidar. tipo='resumen': ventas, facturado, gastos y margen del mes. tipo='gastos': gastos del mes por categoría.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["por_cobrar", "resumen", "gastos"] },
      },
      required: ["tipo"],
    },
  },
  {
    name: "rentabilidad",
    description:
      "Rentabilidad REAL por ruta, cliente o tipo de servicio en los últimos N meses: ventas − costo de proveedor − gastos asignados al servicio. Detecta rutas o clientes en pérdida. Úsala para '¿qué rutas dejan más margen?', '¿dónde estamos perdiendo plata?'.",
    input_schema: {
      type: "object",
      properties: {
        dimension: { type: "string", enum: ["ruta", "cliente", "tipo_servicio"], description: "Por defecto 'ruta'." },
        meses: { type: "integer", description: "Meses hacia atrás incluyendo el actual (1-12, por defecto 1)" },
      },
    },
  },
  {
    name: "desempeno_conductores",
    description:
      "Desempeño operativo de los conductores propios en los últimos N meses: servicios realizados, salidas tarde (check-in vs. hora programada, umbral 15 min), retraso promedio y duración de jornada. Úsala para '¿qué conductor acumula retrasos?', '¿quién trabajó más este mes?'.",
    input_schema: {
      type: "object",
      properties: {
        meses: { type: "integer", description: "1-12, por defecto 1" },
        nombre: { type: "string", description: "Analizar solo un conductor (nombre parcial)" },
      },
    },
  },
  {
    name: "utilizacion_flota",
    description:
      "Uso de la flota en los últimos N meses: servicios y días activos por unidad propia, km recorridos (odómetro), unidades sin uso, y qué % de servicios se fue a terceros. Úsala para '¿qué unidades están paradas?', '¿cuánto estamos tercerizando?'.",
    input_schema: {
      type: "object",
      properties: { meses: { type: "integer", description: "1-12, por defecto 1" } },
    },
  },
  {
    name: "analisis_cotizaciones",
    description:
      "Embudo comercial de cotizaciones de los últimos N meses: cuántas se cotizaron, aprobaron o rechazaron, tasa de cierre, monto cotizado vs. aprobado, y cotizaciones enviadas que siguen sin respuesta (con días de espera). Úsala para '¿cómo va la conversión?', '¿qué cotizaciones hay que perseguir?'.",
    input_schema: {
      type: "object",
      properties: { meses: { type: "integer", description: "1-12, por defecto 1" } },
    },
  },
  {
    name: "ocupacion_servicios",
    description:
      "Ocupación de pasajeros de los servicios de los últimos N meses: % promedio (abordados vs. capacidad), sobrecupos y servicios con baja ocupación (<50%), con las rutas menos ocupadas. Útil para optimizar unidades en transporte de personal.",
    input_schema: {
      type: "object",
      properties: {
        meses: { type: "integer", description: "1-12, por defecto 1" },
        cliente_nombre: { type: "string", description: "Filtrar por cliente (nombre parcial)" },
      },
    },
  },
  {
    name: "tendencia_mensual",
    description:
      "Evolución mes a mes del negocio (últimos N meses): servicios, ventas, margen, gastos y facturado por mes, con la variación del mes en curso vs. el anterior. Úsala para '¿cómo viene el año?', '¿crecimos respecto al mes pasado?'.",
    input_schema: {
      type: "object",
      properties: { meses: { type: "integer", description: "2-12, por defecto 6" } },
    },
  },
  {
    name: "gps_en_vivo",
    description:
      "Unidades transmitiendo GPS en los últimos 30 minutos: quién está en línea, con retraso o sin señal, velocidad y SOS activos. Úsala para '¿dónde están los buses?', '¿está transmitiendo la placa X?'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "consultar_multas",
    description:
      "Multas/papeletas de la flota: pendientes con monto, descuentos por pronto pago que están por vencer (¡ahorro directo!), multas por vencer, y puntos acumulados por conductor (riesgo de suspensión). Filtra por estado o placa.",
    input_schema: {
      type: "object",
      properties: {
        estado: { type: "string", enum: ["Pendiente", "Pagada", "Impugnada", "Vencida", "En proceso"] },
        placa: { type: "string" },
        meses: { type: "integer", description: "Meses hacia atrás por fecha de infracción (1-12, por defecto 3)" },
      },
    },
  },
  {
    name: "consultar_incidencias",
    description:
      "Incidencias operativas (accidentes, fallas, retrasos, robos…): abiertas con su SLA (vencido o no), conteo por tipo y severidad, impacto económico. Úsala para '¿qué incidencias hay abiertas?', '¿se venció algún SLA?'.",
    input_schema: {
      type: "object",
      properties: {
        meses: { type: "integer", description: "1-12, por defecto 1" },
        severidad: { type: "string", enum: ["critico", "alto", "medio", "bajo"] },
        solo_abiertas: { type: "boolean", description: "Solo no cerradas (por defecto true)" },
      },
    },
  },
  {
    name: "consultar_neumaticos",
    description:
      "Vida útil de los neumáticos por unidad y posición: % de desgaste (km recorridos vs vida útil), críticos (≥90%), en observación (70-90%) y costo por km. Filtra por placa.",
    input_schema: {
      type: "object",
      properties: { placa: { type: "string" }, solo_alertas: { type: "boolean" } },
    },
  },
  {
    name: "consultar_seguros",
    description:
      "Pólizas de seguro (SOAT, CAT, SCTR, Vida Ley, Todo Riesgo…): vencidas y por vencer, a qué vehículo o empresa protegen, aseguradora y prima. Los tipos soat/cat/sctr_salud/sctr_pension/vida_ley son obligatorios por ley.",
    input_schema: {
      type: "object",
      properties: { solo_alertas: { type: "boolean", description: "Solo vencidas o por vencer (≤30 días)" } },
    },
  },
  {
    name: "consultar_mantenimiento",
    description:
      "Estado del mantenimiento: órdenes de trabajo abiertas/en proceso (taller, días abiertas, costo), mantenimientos pendientes o próximos (por fecha o km) y gasto del período. Úsala para '¿qué unidades están en taller?', '¿qué mantenimiento viene?'.",
    input_schema: {
      type: "object",
      properties: { meses: { type: "integer", description: "1-12, por defecto 3 (para costos e historial)" } },
    },
  },
  {
    name: "buscar_pasajero",
    description:
      "Busca un pasajero por nombre, DNI o empresa y devuelve sus datos y sus últimos servicios asignados (con estado de abordaje). Úsala para '¿en qué ruta está Juan Pérez?', '¿el DNI 12345678 abordó hoy?'.",
    input_schema: {
      type: "object",
      properties: { busqueda: { type: "string", description: "Nombre, DNI o empresa (parcial)" } },
      required: ["busqueda"],
    },
  },
  {
    name: "consultar_tercerizadas",
    description:
      "Semáforo de riesgo de las EMPRESAS tercerizadas: documentos obligatorios (SOAT, CITV, TUC, Habilitación Vehicular MTC/ATU, Tarjeta de Propiedad, SCTR) vencidos o por vencer, licencias de sus conductores, tamaño de su flota y servicios que nos hicieron en el período. Úsala para '¿qué empresas tercerizadas están en riesgo?', '¿con quién trabajamos más?'.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Filtrar por razón social (parcial)" },
        meses: { type: "integer", description: "Meses para contar servicios (1-12, por defecto 3)" },
      },
    },
  },
  {
    name: "consultar_personal",
    description:
      "Personal administrativo: datos, cargo, departamento y vencimientos SUNAFIL (contrato a plazo fijo, SCTR salud/pensión, examen médico, antecedentes, Vida Ley). Con solo_alertas=true, solo quienes tienen documentos vencidos o por vencer.",
    input_schema: {
      type: "object",
      properties: { nombre: { type: "string" }, solo_alertas: { type: "boolean" } },
    },
  },
  {
    name: "consultar_documentos_empresa",
    description:
      "Documentos corporativos (contratos, SST, capacitaciones, permisos, legales): vencidos y por vencer, por categoría y alcance (empresa, cliente, proveedor, conductor). Úsala para '¿qué contratos vencen pronto?', '¿los docs de SST están al día?'.",
    input_schema: {
      type: "object",
      properties: {
        categoria: { type: "string", enum: ["contrato", "guia_remision", "sst", "capacitacion", "permiso", "legal", "factura", "interno", "otro"] },
        solo_alertas: { type: "boolean" },
      },
    },
  },
  {
    name: "consultar_proveedores",
    description:
      "Directorio de proveedores (talleres, grifos, repuestos, seguros…): busca por nombre o tipo y devuelve contacto y estado.",
    input_schema: {
      type: "object",
      properties: {
        busqueda: { type: "string", description: "Nombre (parcial)" },
        tipo: { type: "string", enum: ["taller", "grifo", "repuestos", "seguros", "neumaticos", "lavadero", "vulcanizadora", "electricista", "administrativo", "otro"] },
      },
    },
  },
  {
    name: "uso_de_elia",
    description:
      "Cuánto ha costado ELIA este mes: gasto acumulado en US$, límite configurado, respuestas dadas y modelo en uso. Solo para administradores. Úsala si preguntan '¿cuánto has gastado?', '¿cuánto cuesta ELIA?'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "abrir_modulo",
    description:
      "Genera un acceso directo (botón) para llevar al usuario a una pantalla del ERP: 'llévame a seguimiento', 'abre la facturación'. Pásale el nombre del módulo o pantalla tal como lo dijo el usuario.",
    input_schema: {
      type: "object",
      properties: { destino: { type: "string", description: "Nombre del módulo/pantalla pedido" } },
      required: ["destino"],
    },
  },
  {
    name: "proponer_accion",
    description:
      "Propone una acción que el usuario debe CONFIRMAR con un botón (nunca se ejecuta sola). tipo='recordatorio_reserva': envía recordatorio (email/WhatsApp) a los pasajeros de un servicio. tipo='confirmar_reserva': pasa un servicio pendiente/programado a confirmado. Requiere reserva_id exacto (búscalo antes).",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["recordatorio_reserva", "confirmar_reserva"] },
        reserva_id: { type: "integer" },
        motivo: { type: "string", description: "Frase corta de por qué se propone" },
      },
      required: ["tipo", "reserva_id"],
    },
  },
];

/** Filtra las herramientas según los permisos del usuario. */
export function toolsPermitidas(permisos: string[], rol: string): any[] {
  return TOOLS_DEF.filter((t) => {
    const req = MODULOS_TOOL[t.name] ?? [];
    return req.length === 0 || tienePermiso({ permisos, rol }, req);
  });
}

// ── Enriquecedores ───────────────────────────────────────────────────────────

async function mapaNombres(sb: SB, tabla: string, ids: number[], cols: string): Promise<Record<number, any>> {
  const unicos = [...new Set(ids.filter(Boolean))];
  if (unicos.length === 0) return {};
  const { data } = await sb.from(tabla).select(cols).in("id", unicos);
  const out: Record<number, any> = {};
  for (const fila of (data as any[]) ?? []) out[fila.id] = fila;
  return out;
}

async function enriquecerReservas(sb: SB, filas: any[]): Promise<ServicioUI[]> {
  const clientes = await mapaNombres(sb, "clientes", filas.map((r) => r.cliente_id), "id, nombre, empresa");
  const vehiculos = await mapaNombres(sb, "vehiculos", filas.map((r) => r.vehiculo_id), "id, placa");
  const vehiculosT = await mapaNombres(sb, "vehiculos_tercero", filas.map((r) => r.vehiculo_tercero_id), "id, placa");
  const conductores = await mapaNombres(sb, "conductores", filas.map((r) => r.conductor_id), "id, nombre");
  const conductoresT = await mapaNombres(sb, "conductores_tercero", filas.map((r) => r.conductor_tercero_id), "id, nombre");

  return filas.map((r) => {
    const cli = r.cliente_id ? clientes[r.cliente_id] : null;
    const placa = r.vehiculo_id
      ? vehiculos[r.vehiculo_id]?.placa
      : r.vehiculo_tercero_id
      ? vehiculosT[r.vehiculo_tercero_id]?.placa
      : null;
    const cond = r.conductor_id
      ? conductores[r.conductor_id]?.nombre
      : r.conductor_tercero_id
      ? conductoresT[r.conductor_tercero_id]?.nombre
      : null;
    return {
      id: r.id,
      codigo: r.codigo ?? null,
      origen: r.origen,
      destino: r.destino,
      fecha: r.fecha_servicio,
      hora: r.hora_servicio,
      estado: r.estado,
      estadoEtiqueta: etiquetaEstado(r.estado),
      adminEtiqueta: r.estado_admin ? etiquetaAdmin(r.estado_admin) : null,
      cliente: cli ? cli.nombre || cli.empresa : null,
      unidad: placa ?? (r.tipo_asignacion === "tercerizado" ? "Tercero s/asignar" : null),
      conductor: cond,
    };
  });
}

const COLS_RESERVA =
  "id, codigo, origen, destino, fecha_servicio, hora_servicio, estado, estado_admin, tipo_servicio_detalle, tipo_asignacion, cliente_id, vehiculo_id, conductor_id, vehiculo_tercero_id, conductor_tercero_id, empresa_tercerizada_id, precio_cliente, margen, pasajeros_abordados, observaciones";

// ── Radar proactivo (compartido por la tool, el endpoint y el saludo) ───────
export async function calcularRadar(sb: SB, permisos: string[], rol: string): Promise<RadarItem[]> {
  const ctx = { permisos, rol };
  const items: RadarItem[] = [];
  const hoy = fechaLima();

  // SOS activos — lo más urgente
  if (tienePermiso(ctx, ["monitoreo", "seguimiento", "dashboard"])) {
    try {
      const { count } = await sb
        .from("alertas_sos")
        .select("id", { count: "exact", head: true })
        .eq("estado", "pendiente");
      if ((count ?? 0) > 0)
        items.push({ nivel: "critico", texto: `${count} alerta(s) SOS sin atender`, href: "/monitoreo" });
    } catch {}
  }

  // Servicios de hoy sin unidad o conductor asignado
  if (tienePermiso(ctx, ["programacion", "despachador", "dashboard"])) {
    try {
      const { data } = await sb
        .from("reservas")
        .select("id, vehiculo_id, vehiculo_tercero_id, conductor_id, conductor_tercero_id, estado")
        .eq("fecha_servicio", hoy)
        .in("estado", ["pendiente", "programada", "confirmada"]);
      const sinRecurso = ((data as any[]) ?? []).filter(
        (r) => (!r.vehiculo_id && !r.vehiculo_tercero_id) || (!r.conductor_id && !r.conductor_tercero_id)
      );
      if (sinRecurso.length > 0)
        items.push({
          nivel: "atencion",
          texto: `${sinRecurso.length} servicio(s) de hoy sin unidad o conductor asignado`,
          href: "/programacion",
        });
    } catch {}
  }

  // Documentos vehiculares obligatorios vencidos / por vencer
  if (tienePermiso(ctx, ["vehiculos", "dashboard"])) {
    try {
      const { data } = await sb.from("documentos_vehiculo").select("vehiculo_id, tipo, fecha_vencimiento");
      let vencidos = 0, porVencer = 0;
      for (const d of (data as any[]) ?? []) {
        if (!DOCS_OBLIGATORIOS.has(etiquetaTipoDoc(d.tipo))) continue;
        if (docSinVencimiento(d.tipo)) continue;
        const dias = diasPara(d.fecha_vencimiento);
        if (dias === null) continue;
        if (dias < 0) vencidos++;
        else if (dias <= 30) porVencer++;
      }
      if (vencidos > 0)
        items.push({ nivel: "critico", texto: `${vencidos} documento(s) vehicular(es) obligatorio(s) VENCIDO(S)`, href: "/documentos-vehiculares" });
      if (porVencer > 0)
        items.push({ nivel: "atencion", texto: `${porVencer} documento(s) vehicular(es) vencen en ≤30 días`, href: "/documentos-vehiculares" });
    } catch {}
  }

  // Empresas tercerizadas con documentos obligatorios vencidos
  if (tienePermiso(ctx, ["proveedores", "vehiculos", "dashboard"])) {
    try {
      const { data } = await sb.from("documentos_tercero").select("empresa_id, tipo, fecha_vencimiento");
      const vencidasPorEmpresa = new Set<number>();
      const porVencerPorEmpresa = new Set<number>();
      for (const d of (data as any[]) ?? []) {
        if (docSinVencimiento(d.tipo)) continue;
        const dias = diasPara(d.fecha_vencimiento);
        if (dias === null) continue;
        if (dias < 0) vencidasPorEmpresa.add(d.empresa_id);
        else if (dias <= 30) porVencerPorEmpresa.add(d.empresa_id);
      }
      if (vencidasPorEmpresa.size > 0)
        items.push({
          nivel: "critico",
          texto: `${vencidasPorEmpresa.size} empresa(s) tercerizada(s) con documentos VENCIDOS`,
          href: "/tercerizadas",
        });
      if (porVencerPorEmpresa.size > 0)
        items.push({
          nivel: "atencion",
          texto: `${porVencerPorEmpresa.size} empresa(s) tercerizada(s) con documentos por vencer (≤30 días)`,
          href: "/tercerizadas",
        });
    } catch {}
  }

  // Licencias de conductores
  if (tienePermiso(ctx, ["conductores", "dashboard"])) {
    try {
      const { data } = await sb.from("conductores").select("id, nombre, vencimiento_licencia, estado").neq("estado", "de_baja");
      let vencidas = 0, porVencer = 0;
      for (const c of (data as any[]) ?? []) {
        const dias = diasPara(c.vencimiento_licencia);
        if (dias === null) continue;
        if (dias < 0) vencidas++;
        else if (dias <= 30) porVencer++;
      }
      if (vencidas > 0) items.push({ nivel: "critico", texto: `${vencidas} licencia(s) de conducir vencida(s)`, href: "/conductores" });
      if (porVencer > 0) items.push({ nivel: "atencion", texto: `${porVencer} licencia(s) vencen en ≤30 días`, href: "/conductores" });
    } catch {}
  }

  // Multas: pronto pago por vencer (ahorro directo si se paga a tiempo)
  if (tienePermiso(ctx, ["multas", "dashboard"])) {
    try {
      const { data } = await sb
        .from("multas")
        .select("id, monto_original, monto_pronto_pago, fecha_limite_pronto_pago")
        .eq("estado", "Pendiente")
        .eq("tiene_pronto_pago", true)
        .not("fecha_limite_pronto_pago", "is", null);
      const urgentes = ((data as any[]) ?? []).filter((m) => {
        const d = diasPara(m.fecha_limite_pronto_pago);
        return d !== null && d >= 0 && d <= 3;
      });
      if (urgentes.length > 0) {
        const ahorro = urgentes.reduce((s, m) => s + (Number(m.monto_original || 0) - Number(m.monto_pronto_pago || 0)), 0);
        items.push({
          nivel: "critico",
          texto: `${urgentes.length} multa(s) con pronto pago que vence en ≤3 días (ahorro ${fmtSoles(ahorro)})`,
          href: "/multas",
        });
      }
    } catch {}
  }

  // Incidencias abiertas con SLA vencido
  if (tienePermiso(ctx, ["incidencias", "seguimiento", "dashboard"])) {
    try {
      const { data } = await sb
        .from("incidencias")
        .select("id, sla_limite_h, created_at, estado")
        .neq("estado", "cerrado")
        .limit(200);
      const vencidas = ((data as any[]) ?? []).filter(
        (i) => i.sla_limite_h && (Date.now() - new Date(i.created_at).getTime()) / 3600000 > Number(i.sla_limite_h)
      );
      if (vencidas.length > 0)
        items.push({ nivel: "atencion", texto: `${vencidas.length} incidencia(s) abierta(s) con SLA vencido`, href: "/incidencias" });
    } catch {}
  }

  // Cobranza: facturas vencidas + servicios por liquidar
  if (tienePermiso(ctx, ["facturacion", "reportes"])) {
    try {
      const { data } = await sb
        .from("facturas")
        .select("id, total, fecha_vencimiento, estado")
        .in("estado", ["emitida", "enviada", "vencida"]);
      const vencidas = ((data as any[]) ?? []).filter((f) => {
        const dias = diasPara(f.fecha_vencimiento);
        return dias !== null && dias < 0;
      });
      if (vencidas.length > 0) {
        const monto = vencidas.reduce((s, f) => s + Number(f.total || 0), 0);
        items.push({ nivel: "atencion", texto: `${vencidas.length} factura(s) vencida(s) por ${fmtSoles(monto)}`, href: "/facturacion" });
      }
      const { count } = await sb
        .from("reservas")
        .select("id", { count: "exact", head: true })
        .eq("estado", "finalizada")
        .eq("estado_admin", "por_liquidar");
      if ((count ?? 0) > 3)
        items.push({ nivel: "info", texto: `${count} servicios finalizados por liquidar`, href: "/facturacion" });
    } catch {}
  }

  const orden = { critico: 0, atencion: 1, info: 2 } as const;
  return items.sort((a, b) => orden[a.nivel] - orden[b.nivel]).slice(0, 6);
}

// ── Ejecutor ─────────────────────────────────────────────────────────────────

export type ResultadoTool = { paraModelo: string; ui?: BloqueUI | BloqueUI[] };

export async function ejecutarToolElia(nombre: string, input: any, ctx: CtxElia): Promise<ResultadoTool> {
  const { sb } = ctx;
  try {
    switch (nombre) {
      // ────────────────────────────────────────────────────────────────────
      case "resumen_operativo": {
        const hoy = fechaLima();
        const { data } = await sb
          .from("reservas")
          .select("id, estado")
          .eq("fecha_servicio", hoy);
        const filas = (data as any[]) ?? [];
        const porEstado: Record<string, number> = {};
        for (const r of filas) porEstado[r.estado] = (porEstado[r.estado] || 0) + 1;
        const radar = await calcularRadar(sb, ctx.permisos, ctx.rol);

        const kpis: KpiUI[] = [
          { label: "Servicios hoy", valor: String(filas.length), intent: "info" },
          { label: "En curso", valor: String(porEstado["en_curso"] || 0), intent: "ok" },
          {
            label: "Por confirmar",
            valor: String((porEstado["pendiente"] || 0) + (porEstado["programada"] || 0)),
            intent: (porEstado["pendiente"] || 0) + (porEstado["programada"] || 0) > 0 ? "warn" : "ok",
          },
          {
            label: "Avisos del radar",
            valor: String(radar.length),
            intent: radar.some((r) => r.nivel === "critico") ? "danger" : radar.length ? "warn" : "ok",
          },
        ];
        return {
          paraModelo: JSON.stringify({ fecha: hoy, servicios_hoy: filas.length, por_estado: porEstado, radar }),
          ui: { tipo: "kpis", items: kpis },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "buscar_servicios": {
        let q = sb.from("reservas").select(COLS_RESERVA);
        const desde = input.fecha_desde || fechaLima();
        const hasta = input.fecha_hasta || desde;
        q = q.gte("fecha_servicio", desde).lte("fecha_servicio", hasta);
        if (input.estado) q = q.eq("estado", input.estado);
        if (input.texto) q = q.or(`origen.ilike.%${input.texto}%,destino.ilike.%${input.texto}%`);

        if (input.cliente_nombre) {
          const { data: clis } = await sb
            .from("clientes")
            .select("id")
            .or(`nombre.ilike.%${input.cliente_nombre}%,empresa.ilike.%${input.cliente_nombre}%`)
            .limit(20);
          const ids = ((clis as any[]) ?? []).map((c) => c.id);
          if (ids.length === 0)
            return { paraModelo: JSON.stringify({ encontrados: 0, nota: `No encontré clientes que coincidan con "${input.cliente_nombre}".` }) };
          q = q.in("cliente_id", ids);
        }

        if (input.placa) {
          const [{ data: vp }, { data: vt }] = await Promise.all([
            sb.from("vehiculos").select("id").ilike("placa", `%${input.placa}%`),
            sb.from("vehiculos_tercero").select("id").ilike("placa", `%${input.placa}%`),
          ]);
          const idsP = ((vp as any[]) ?? []).map((v) => v.id);
          const idsT = ((vt as any[]) ?? []).map((v) => v.id);
          if (idsP.length === 0 && idsT.length === 0)
            return { paraModelo: JSON.stringify({ encontrados: 0, nota: `No hay vehículos con placa parecida a "${input.placa}".` }) };
          const partes: string[] = [];
          if (idsP.length) partes.push(`vehiculo_id.in.(${idsP.join(",")})`);
          if (idsT.length) partes.push(`vehiculo_tercero_id.in.(${idsT.join(",")})`);
          q = q.or(partes.join(","));
        }

        const { data } = await q.order("fecha_servicio").order("hora_servicio").limit(25);
        const filas = (data as any[]) ?? [];
        if (filas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, rango: [desde, hasta], nota: "Sin servicios con esos filtros." }) };

        const items = await enriquecerReservas(sb, filas);
        const verPrecios = puedeVerPrecios(ctx);
        const paraModelo = filas.map((r, i) => ({
          ...items[i],
          tipo_servicio: r.tipo_servicio_detalle,
          asignacion: r.tipo_asignacion,
          ...(verPrecios ? { precio_cliente: r.precio_cliente, margen: r.margen } : {}),
        }));
        return {
          paraModelo: JSON.stringify({ encontrados: filas.length, rango: [desde, hasta], servicios: paraModelo }),
          ui: { tipo: "servicios", items: items.slice(0, 8) },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "detalle_servicio": {
        const { data: r } = await sb.from("reservas").select(COLS_RESERVA).eq("id", input.reserva_id).maybeSingle();
        if (!r) return { paraModelo: JSON.stringify({ error: `No existe el servicio ${input.reserva_id}.` }) };

        const [items, { data: paradas }, { data: ocup }, { data: gastos }] = await Promise.all([
          enriquecerReservas(sb, [r]),
          sb.from("paradas").select("orden, nombre, direccion, hora_estimada, estado").eq("reserva_id", r.id).order("orden"),
          sb.from("reservas_ocupacion").select("*").eq("reserva_id", r.id).maybeSingle(),
          sb.from("gastos").select("categoria, monto, descripcion").eq("reserva_id", r.id).neq("estado", "anulado"),
        ]);

        const totalGastos = ((gastos as any[]) ?? []).reduce((s, g) => s + Number(g.monto || 0), 0);
        const verPrecios = puedeVerPrecios(ctx);
        return {
          paraModelo: JSON.stringify({
            servicio: {
              ...items[0],
              observaciones: (r as any).observaciones,
              pasajeros_abordados: (r as any).pasajeros_abordados,
              ...(verPrecios ? { precio_cliente: (r as any).precio_cliente, margen: (r as any).margen, gastos_registrados: totalGastos } : {}),
            },
            paradas: paradas ?? [],
            ocupacion: ocup ?? null,
            ...(verPrecios ? { gastos: gastos ?? [] } : {}),
          }),
          ui: { tipo: "servicios", items },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_flota": {
        const alcance: "propia" | "terceros" | "toda" =
          input.flota === "propia" || input.flota === "terceros" ? input.flota : "toda";

        // ── Flota propia (documentos por vehículo)
        let itemsPropios: VehiculoUI[] = [];
        if (alcance !== "terceros") {
          let q = sb
            .from("vehiculos")
            .select("id, placa, categoria, marca, modelo, estado, estado_operativo, kilometraje_actual, proximo_mantenimiento_km, capacidad_pasajeros");
          if (input.placa) q = q.ilike("placa", `%${input.placa}%`);
          const { data } = await q.order("placa").limit(60);
          const flota = (data as any[]) ?? [];

          if (flota.length > 0) {
            const { data: docs } = await sb
              .from("documentos_vehiculo")
              .select("vehiculo_id, tipo, fecha_vencimiento")
              .in("vehiculo_id", flota.map((v) => v.id));

            const porVehiculo: Record<number, { tipo: string; dias: number }[]> = {};
            for (const d of (docs as any[]) ?? []) {
              if (docSinVencimiento(d.tipo)) continue;
              const dias = diasPara(d.fecha_vencimiento);
              if (dias === null || dias > 30) continue;
              (porVehiculo[d.vehiculo_id] ||= []).push({ tipo: etiquetaTipoDoc(d.tipo), dias });
            }

            itemsPropios = flota.map((v) => {
              const avisos = (porVehiculo[v.id] ?? []).sort((a, b) => a.dias - b.dias);
              const alertas: string[] = avisos.map((a) =>
                a.dias < 0 ? `${a.tipo} VENCIDO hace ${Math.abs(a.dias)} día(s)` : `${a.tipo} vence en ${a.dias} día(s)`
              );
              const kmRestante =
                v.proximo_mantenimiento_km && v.kilometraje_actual
                  ? Number(v.proximo_mantenimiento_km) - Number(v.kilometraje_actual)
                  : null;
              if (kmRestante !== null && kmRestante <= 500)
                alertas.push(kmRestante < 0 ? `Mantenimiento VENCIDO por ${Math.abs(kmRestante)} km` : `Mantenimiento en ${kmRestante} km`);

              const rojo =
                v.estado_operativo === "no_apto" ||
                avisos.some((a) => a.dias < 0 && DOCS_OBLIGATORIOS.has(a.tipo)) ||
                (kmRestante !== null && kmRestante < 0);
              const semaforo: VehiculoUI["semaforo"] = rojo ? "rojo" : alertas.length > 0 ? "ambar" : "verde";
              return {
                placa: v.placa,
                categoria: v.categoria,
                marcaModelo: [v.marca, v.modelo].filter(Boolean).join(" ") || null,
                estado: v.estado,
                semaforo,
                alertas,
              };
            });
          }
        }

        // ── Flota tercerizada (documentos por EMPRESA o por vehículo específico)
        let itemsTerceros: VehiculoUI[] = [];
        let resumenEmpresas: any[] = [];
        if (alcance !== "propia") {
          const [{ data: emp }, { data: vt }, { data: dt }] = await Promise.all([
            sb.from("empresas_tercerizadas").select("id, razon_social, ruc, estado, venc_autorizacion"),
            (() => {
              let q = sb.from("vehiculos_tercero").select("id, empresa_id, placa, categoria, marca, estado");
              if (input.placa) q = q.ilike("placa", `%${input.placa}%`);
              return q.order("placa").limit(80);
            })(),
            sb.from("documentos_tercero").select("empresa_id, vehiculo_id, tipo, fecha_vencimiento"),
          ]);
          const empresas = (emp as any[]) ?? [];
          const empresaPorId: Record<number, any> = {};
          for (const e of empresas) empresaPorId[e.id] = e;

          // Documentos de nivel empresa (vehiculo_id null) + permisos propios de la empresa
          const docsEmpresa: Record<number, { tipo: string; dias: number }[]> = {};
          const docsVehiculo: Record<number, { tipo: string; dias: number }[]> = {};
          for (const d of (dt as any[]) ?? []) {
            const dias = diasPara(d.fecha_vencimiento);
            if (dias === null || dias > 30) continue;
            if (d.vehiculo_id) (docsVehiculo[d.vehiculo_id] ||= []).push({ tipo: d.tipo, dias });
            else (docsEmpresa[d.empresa_id] ||= []).push({ tipo: d.tipo, dias });
          }
          for (const e of empresas) {
            for (const [campo, etiqueta] of [
              ["venc_autorizacion", "Autorización de transporte"],
              ] as [string, string][]) {
              const dias = diasPara(e[campo]);
              if (dias !== null && dias <= 30) (docsEmpresa[e.id] ||= []).push({ tipo: etiqueta, dias });
            }
          }

          itemsTerceros = ((vt as any[]) ?? []).map((v) => {
            const empresa = empresaPorId[v.empresa_id];
            const nombreEmpresa = empresa?.razon_social || `Empresa #${v.empresa_id}`;
            const avisos = [...(docsVehiculo[v.id] ?? []), ...(docsEmpresa[v.empresa_id] ?? [])].sort((a, b) => a.dias - b.dias);
            const alertas = avisos.map((a) =>
              a.dias < 0
                ? `${a.tipo} VENCIDO hace ${Math.abs(a.dias)} día(s)`
                : `${a.tipo} vence en ${a.dias} día(s)`
            );
            const rojo = avisos.some((a) => a.dias < 0);
            const semaforo: VehiculoUI["semaforo"] = rojo ? "rojo" : alertas.length > 0 ? "ambar" : "verde";
            return {
              placa: v.placa || "(sin placa)",
              categoria: v.categoria,
              marcaModelo: [v.marca, `· ${nombreEmpresa}`].filter(Boolean).join(" "),
              estado: v.estado,
              semaforo,
              alertas,
            };
          });

          resumenEmpresas = empresas.map((e) => {
            const avisos = docsEmpresa[e.id] ?? [];
            return {
              empresa: e.razon_social,
              estado: e.estado,
              docs_vencidos: avisos.filter((a) => a.dias < 0).map((a) => a.tipo),
              docs_por_vencer: avisos.filter((a) => a.dias >= 0).map((a) => `${a.tipo} (${a.dias}d)`),
            };
          });
        }

        const todos = [...itemsPropios, ...itemsTerceros];
        if (todos.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, alcance, nota: "Sin unidades que coincidan con el filtro." }) };
        const visibles = input.solo_alertas ? todos.filter((i) => i.semaforo !== "verde") : todos;

        return {
          paraModelo: JSON.stringify({
            alcance,
            encontrados: visibles.length,
            flota_propia: itemsPropios.length,
            flota_tercerizada: itemsTerceros.length,
            vehiculos: visibles,
            empresas_tercerizadas: resumenEmpresas,
            nota: "Los documentos de la flota tercerizada (SOAT, CITV, SUTRAN, MTC) se registran por EMPRESA, no por vehículo: un documento vencido afecta a todas las unidades de esa empresa.",
          }),
          ui: { tipo: "vehiculos", items: visibles.slice(0, 12) },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_conductores": {
        const alcance: "propia" | "terceros" | "toda" =
          input.flota === "propia" || input.flota === "terceros" ? input.flota : "toda";

        let items: ConductorUI[] = [];

        if (alcance !== "terceros") {
          let q = sb
            .from("conductores")
            .select(
              "id, nombre, telefono, estado, licencia, categoria_licencia, vencimiento_licencia, sctr_salud_venc, sctr_pension_venc, examen_medico_venc, psicosometrico_venc, antecedentes_venc, vida_ley_venc"
            )
            .neq("estado", "de_baja");
          if (input.nombre) q = q.ilike("nombre", `%${input.nombre}%`);
          const { data } = await q.order("nombre").limit(60);

          const DOCS: [string, string][] = [
            ["vencimiento_licencia", "Licencia"],
            ["sctr_salud_venc", "SCTR Salud"],
            ["sctr_pension_venc", "SCTR Pensión"],
            ["examen_medico_venc", "Examen médico"],
            ["psicosometrico_venc", "Psicosométrico"],
            ["antecedentes_venc", "Antecedentes"],
            ["vida_ley_venc", "Vida Ley"],
          ];
          items = ((data as any[]) ?? []).map((c) => {
            const alertas: string[] = [];
            for (const [campo, etiqueta] of DOCS) {
              const dias = diasPara(c[campo]);
              if (dias === null) continue;
              if (dias < 0) alertas.push(`${etiqueta} VENCIDO hace ${Math.abs(dias)} día(s)`);
              else if (dias <= 30) alertas.push(`${etiqueta} vence en ${dias} día(s)`);
            }
            return { nombre: c.nombre, estado: c.estado, telefono: c.telefono, alertas };
          });
        }

        if (alcance !== "propia") {
          let q = sb.from("conductores_tercero").select("id, empresa_id, nombre, licencia, vencimiento_licencia, telefono, estado");
          if (input.nombre) q = q.ilike("nombre", `%${input.nombre}%`);
          const [{ data: ct }, { data: emp }] = await Promise.all([
            q.order("nombre").limit(60),
            sb.from("empresas_tercerizadas").select("id, razon_social"),
          ]);
          const empresaPorId: Record<number, string> = {};
          for (const e of (emp as any[]) ?? []) empresaPorId[e.id] = e.razon_social;

          items = items.concat(
            (((ct as any[]) ?? [])).map((c) => {
              const alertas: string[] = [];
              const dias = diasPara(c.vencimiento_licencia);
              if (dias !== null) {
                if (dias < 0) alertas.push(`Licencia VENCIDA hace ${Math.abs(dias)} día(s)`);
                else if (dias <= 30) alertas.push(`Licencia vence en ${dias} día(s)`);
              }
              return {
                nombre: c.nombre,
                estado: `tercero · ${empresaPorId[c.empresa_id] || "empresa #" + c.empresa_id}`,
                telefono: c.telefono,
                alertas,
              };
            })
          );
        }

        if (items.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, alcance, nota: "Sin conductores que coincidan con el filtro." }) };
        const visibles = input.solo_alertas ? items.filter((i) => i.alertas.length > 0) : items;
        return {
          paraModelo: JSON.stringify({
            alcance,
            encontrados: visibles.length,
            conductores: visibles,
            nota: alcance !== "propia" ? "De los conductores terceros solo se registra la licencia; los demás documentos los gestiona su empresa." : undefined,
          }),
          ui: { tipo: "conductores", items: visibles.slice(0, 10) },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_clientes": {
        const { data } = await sb
          .from("clientes")
          .select("id, nombre, empresa, tipo, ruc, telefono, email, estado, condicion_pago")
          .or(`nombre.ilike.%${input.nombre}%,empresa.ilike.%${input.nombre}%`)
          .limit(5);
        const clientes = (data as any[]) ?? [];
        if (clientes.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, nota: `No encontré clientes con "${input.nombre}".` }) };

        const inicioMes = fechaLima().slice(0, 8) + "01";
        const mesPrevFin = fechaLima(-Number(fechaLima().slice(8, 10)));
        const mesPrevIni = mesPrevFin.slice(0, 8) + "01";

        const detalle = await Promise.all(
          clientes.map(async (c) => {
            const [{ count: actual }, { count: anterior }] = await Promise.all([
              sb.from("reservas").select("id", { count: "exact", head: true }).eq("cliente_id", c.id).gte("fecha_servicio", inicioMes).neq("estado", "cancelada"),
              sb.from("reservas").select("id", { count: "exact", head: true }).eq("cliente_id", c.id).gte("fecha_servicio", mesPrevIni).lte("fecha_servicio", mesPrevFin).neq("estado", "cancelada"),
            ]);
            const a = actual ?? 0, b = anterior ?? 0;
            const variacion = b > 0 ? Math.round(((a - b) / b) * 100) : a > 0 ? 100 : 0;
            return { ...c, servicios_mes_actual: a, servicios_mes_anterior: b, variacion_pct: variacion };
          })
        );

        let ui: BloqueUI | undefined;
        if (detalle.length === 1) {
          const c = detalle[0];
          ui = {
            tipo: "kpis",
            items: [
              { label: "Servicios este mes", valor: String(c.servicios_mes_actual), intent: "info" },
              { label: "Mes anterior", valor: String(c.servicios_mes_anterior) },
              {
                label: "Variación",
                valor: `${c.variacion_pct > 0 ? "+" : ""}${c.variacion_pct}%`,
                intent: c.variacion_pct > 0 ? "ok" : c.variacion_pct < 0 ? "danger" : "info",
              },
            ],
          };
        }
        return { paraModelo: JSON.stringify({ encontrados: detalle.length, clientes: detalle }), ui };
      }

      // ────────────────────────────────────────────────────────────────────
      case "ranking_clientes": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const top = Math.min(Math.max(Number(input.top) || 5, 1), 10);
        const hoy = fechaLima();
        const totalMeses = Number(hoy.slice(0, 4)) * 12 + (Number(hoy.slice(5, 7)) - 1) - (meses - 1);
        const inicio = `${Math.floor(totalMeses / 12)}-${String((totalMeses % 12) + 1).padStart(2, "0")}-01`;

        const verPrecios = puedeVerPrecios(ctx);
        const criterio: "ventas" | "margen" | "servicios" =
          !verPrecios ? "servicios" : input.criterio === "margen" || input.criterio === "servicios" ? input.criterio : "ventas";

        // Paginar: Supabase corta en 1000 filas por consulta
        const filas: any[] = [];
        for (let pagina = 0; pagina < 5; pagina++) {
          const { data } = await sb
            .from("reservas")
            .select("cliente_id, precio_cliente, margen")
            .gte("fecha_servicio", inicio)
            .lte("fecha_servicio", hoy)
            .neq("estado", "cancelada")
            .not("cliente_id", "is", null)
            .range(pagina * 1000, pagina * 1000 + 999);
          const lote = (data as any[]) ?? [];
          filas.push(...lote);
          if (lote.length < 1000) break;
        }
        if (filas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "No hay servicios (no cancelados) en ese rango." }) };

        const acc: Record<number, { servicios: number; ventas: number; margen: number }> = {};
        for (const r of filas) {
          const a = (acc[r.cliente_id] ||= { servicios: 0, ventas: 0, margen: 0 });
          a.servicios++;
          a.ventas += Number(r.precio_cliente || 0);
          a.margen += Number(r.margen || 0);
        }
        const orden = Object.entries(acc)
          .map(([id, a]) => ({ cliente_id: Number(id), ...a }))
          .sort((x, y) => y[criterio] - x[criterio])
          .slice(0, top);

        const nombres = await mapaNombres(sb, "clientes", orden.map((o) => o.cliente_id), "id, nombre, empresa");
        const ranking = orden.map((o, i) => ({
          puesto: i + 1,
          cliente: nombres[o.cliente_id]?.nombre || nombres[o.cliente_id]?.empresa || `Cliente #${o.cliente_id}`,
          servicios: o.servicios,
          ...(verPrecios ? { ventas: Math.round(o.ventas * 100) / 100, margen: Math.round(o.margen * 100) / 100 } : {}),
        }));

        const items: RankingUI[] = ranking.map((r: any) => ({
          puesto: r.puesto,
          nombre: r.cliente,
          valor:
            criterio === "servicios" ? `${r.servicios} servicio${r.servicios === 1 ? "" : "s"}` : fmtSoles(criterio === "margen" ? r.margen : r.ventas),
          sub:
            criterio === "servicios"
              ? undefined
              : `${r.servicios} servicio${r.servicios === 1 ? "" : "s"}${criterio === "ventas" && r.margen != null ? ` · margen ${fmtSoles(r.margen)}` : ""}`,
        }));

        const etiquetaCriterio = criterio === "ventas" ? "por ventas" : criterio === "margen" ? "por margen" : "por n.º de servicios";
        return {
          paraModelo: JSON.stringify({
            criterio,
            desde: inicio,
            hasta: hoy,
            clientes_con_actividad: Object.keys(acc).length,
            ranking,
            ...(!verPrecios && input.criterio && input.criterio !== "servicios"
              ? { nota: "El usuario no tiene permisos financieros: el ranking es por número de servicios, sin montos." }
              : {}),
          }),
          ui: { tipo: "ranking", titulo: `Top clientes ${etiquetaCriterio}`, items },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "analisis_combustible": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const hoy = fechaLima();
        const totalMeses = Number(hoy.slice(0, 4)) * 12 + (Number(hoy.slice(5, 7)) - 1) - (meses - 1);
        const inicio = `${Math.floor(totalMeses / 12)}-${String((totalMeses % 12) + 1).padStart(2, "0")}-01`;
        const agrupar: "conductor" | "vehiculo" = input.agrupar === "vehiculo" ? "vehiculo" : "conductor";

        // Vehículos (para placas, categorías y capacidad de tanque)
        let qVeh = sb.from("vehiculos").select("id, placa, categoria");
        if (input.placa) qVeh = qVeh.ilike("placa", `%${input.placa}%`);
        const { data: vehs } = await qVeh;
        const vehiculos = (vehs as any[]) ?? [];
        if (input.placa && vehiculos.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, nota: `No hay vehículos con placa parecida a "${input.placa}".` }) };
        const porVehiculoId: Record<number, any> = {};
        for (const v of vehiculos) porVehiculoId[v.id] = v;

        // Cargas del período (paginado contra el corte de 1000 filas)
        const cargas: any[] = [];
        for (let pagina = 0; pagina < 5; pagina++) {
          let q = sb
            .from("combustible")
            .select("id, vehiculo_id, fecha, kilometraje, galones, precio_galon, total, grifo, conductor, tipo_combustible, unidad")
            .gte("fecha", inicio)
            .lte("fecha", hoy)
            .order("fecha")
            .range(pagina * 1000, pagina * 1000 + 999);
          if (input.placa) q = q.in("vehiculo_id", vehiculos.map((v) => v.id));
          const { data } = await q;
          const lote = (data as any[]) ?? [];
          cargas.push(...lote);
          if (lote.length < 1000) break;
        }
        if (cargas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "No hay cargas de combustible registradas en ese rango." }) };

        const gastoDe = (c: any) => Number(c.total || 0) || Number(c.galones || 0) * Number(c.precio_galon || 0);

        // ── Agrupación (conductor = texto libre del registro; puede venir vacío)
        const grupos: Record<string, { etiqueta: string; cargas: number; cantidad: number; gasto: number; vehiculos: Set<string> }> = {};
        for (const c of cargas) {
          const crudo = agrupar === "conductor" ? (c.conductor || "").trim() : porVehiculoId[c.vehiculo_id]?.placa || `Vehículo #${c.vehiculo_id}`;
          const etiqueta = crudo || "(sin conductor registrado)";
          const clave = etiqueta.toLowerCase();
          const g = (grupos[clave] ||= { etiqueta, cargas: 0, cantidad: 0, gasto: 0, vehiculos: new Set() });
          g.cargas++;
          g.cantidad += Number(c.galones || 0);
          g.gasto += gastoDe(c);
          const placa = porVehiculoId[c.vehiculo_id]?.placa;
          if (placa) g.vehiculos.add(placa);
        }
        const rankingGrupos = Object.values(grupos)
          .sort((a, b) => b.gasto - a.gasto)
          .slice(0, 8);

        // ── Rendimiento y anomalías por vehículo+tipo (cargas ordenadas por km)
        // Capacidades estimadas de tanque (mismas heurísticas que el módulo Combustible)
        const CAPACIDAD: Record<string, number> = { BUS: 100, CUSTER: 100, MINIBUS: 60, VAN: 20, AUTO: 12, SUV: 15 };
        const capacidadDe = (categoria?: string | null) => {
          const cat = (categoria || "").toUpperCase();
          for (const [k, v] of Object.entries(CAPACIDAD)) if (cat.includes(k)) return v;
          return 80;
        };

        type Anomalia = { fecha: string; placa: string; conductor: string | null; detalle: string; monto: number };
        const anomalias: Anomalia[] = [];
        const rendimientosPorVehiculo: Record<string, number[]> = {};

        const porSerie: Record<string, any[]> = {};
        for (const c of cargas) {
          if (!c.vehiculo_id) continue;
          const tipo = c.tipo_combustible || "diesel";
          if (tipo === "urea") continue; // aditivo: no aplica rendimiento km/gal
          (porSerie[`${c.vehiculo_id}-${tipo}`] ||= []).push(c);
        }

        for (const [serie, lista] of Object.entries(porSerie)) {
          const vehId = Number(serie.split("-")[0]);
          const placa = porVehiculoId[vehId]?.placa || `#${vehId}`;
          const cap = capacidadDe(porVehiculoId[vehId]?.categoria);

          // Doble carga el mismo día + sobre-capacidad
          const porDia: Record<string, number> = {};
          for (const c of lista) {
            porDia[c.fecha] = (porDia[c.fecha] || 0) + 1;
            if (Number(c.galones) > cap * 1.1)
              anomalias.push({
                fecha: c.fecha,
                placa,
                conductor: c.conductor,
                detalle: `Carga de ${Number(c.galones).toFixed(1)} gal supera la capacidad estimada del tanque (~${cap} gal)`,
                monto: gastoDe(c),
              });
          }
          for (const [fecha, n] of Object.entries(porDia)) {
            if (n > 1) {
              const delDia = lista.filter((c) => c.fecha === fecha);
              anomalias.push({
                fecha,
                placa,
                conductor: delDia[0]?.conductor ?? null,
                detalle: `${n} cargas el mismo día (${delDia.map((c) => `${Number(c.galones).toFixed(0)} gal`).join(" + ")})`,
                monto: delDia.reduce((s, c) => s + gastoDe(c), 0),
              });
            }
          }

          // Rendimiento entre cargas consecutivas. La fórmula la decide lib/rendimiento.ts:
          // el bucle que había aquí era la cuarta copia, con su propio umbral (0.6 en vez de
          // 0.7) y su propia puerta (3 tramos en vez de 5).
          const porId = new Map(lista.map((c: any) => [c.id, c]));
          const series = seriesRendimiento(
            lista.map((c: any) => ({
              id: c.id,
              unidad: placa,
              fecha: String(c.fecha ?? "").slice(0, 10),
              kilometraje: c.kilometraje,
              cantidad: c.galones,
              unidadCantidad: c.unidad,
              tipo: c.tipo_combustible,
            }))
          );

          for (const s of series.values()) {
            if (s.resumen.mediana) (rendimientosPorVehiculo[placa] ||= []).push(s.resumen.mediana);
            for (const t of s.tramos) {
              const c = porId.get(t.cargaId);
              if (!c) continue;

              // Una carga que no aporta km al libro. Antes solo se veía el caso "el odómetro
              // no avanzó"; ahora también la que se guardó sin kilometraje, que es la que de
              // verdad deja combustible fuera de toda medición.
              if (t.motivo === "sin_odometro" || t.motivo === "odometro_retrocede") {
                anomalias.push({
                  fecha: c.fecha, placa, conductor: c.conductor,
                  detalle: `Cargó ${Number(c.galones).toFixed(1)} gal y ${t.motivo === "sin_odometro" ? "no se registró el kilometraje" : "el odómetro no avanzó"}: ese combustible no entra a ninguna medición`,
                  monto: gastoDe(c),
                });
                continue;
              }

              const h = juzgarTramo(t, s.resumen);
              if (h) {
                anomalias.push({
                  fecha: c.fecha, placa, conductor: c.conductor,
                  detalle: h.detalle,
                  monto: gastoDe(c),
                });
              }
            }
          }
        }

        anomalias.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
        const gastoTotal = cargas.reduce((s, c) => s + gastoDe(c), 0);

        const bloqueRanking: BloqueUI = {
          tipo: "ranking",
          titulo: `Consumo de combustible por ${agrupar} (gasto)`,
          items: rankingGrupos.slice(0, 5).map((g, i) => ({
            puesto: i + 1,
            nombre: g.etiqueta,
            valor: fmtSoles(g.gasto),
            sub: `${g.cargas} carga${g.cargas === 1 ? "" : "s"} · ${g.cantidad.toFixed(0)} gal${agrupar === "conductor" && g.vehiculos.size ? ` · ${[...g.vehiculos].slice(0, 3).join(", ")}` : ""}`,
          })),
        };

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            hasta: hoy,
            cargas_totales: cargas.length,
            gasto_total: Math.round(gastoTotal * 100) / 100,
            agrupado_por: agrupar,
            ranking: rankingGrupos.map((g) => ({
              grupo: g.etiqueta,
              cargas: g.cargas,
              galones: Math.round(g.cantidad * 10) / 10,
              gasto: Math.round(g.gasto * 100) / 100,
              vehiculos: [...g.vehiculos],
            })),
            rendimiento_promedio_km_gal: Object.fromEntries(
              Object.entries(rendimientosPorVehiculo).map(([p, r]) => [p, Math.round((r.reduce((s, n) => s + n, 0) / r.length) * 10) / 10])
            ),
            patrones_inusuales: anomalias.slice(0, 12),
            notas: [
              "El campo 'conductor' de cada carga es texto libre: puede venir vacío o escrito distinto (agrupa lo evidente y menciónalo si hay '(sin conductor registrado)').",
              "IMPORTANTE: presenta los patrones inusuales como situaciones PARA REVISAR con el responsable; NUNCA acuses a una persona de robo — los datos no prueban intención.",
              "UN RENDIMIENTO IMPOSIBLEMENTE ALTO NO ES UN BUEN CONDUCTOR: es una carga que FALTA POR REGISTRAR. El combustible se compró y se consumió, pero no está en el libro, así que el costo de esa unidad sale más bajo del real y el margen de sus servicios, más alto. Nunca lo presentes como una buena noticia ni felicites a nadie por él: lo que hay que hacer es buscar el comprobante que falta.",
              "El rendimiento por vehículo es la MEDIANA de sus tramos, no el promedio, y excluye los tramos que no se pudieron medir (cargas sin kilometraje, odómetro que retrocede, resultados imposibles). Si una unidad tiene pocos tramos, dilo en vez de tratar su número como firme.",
            ],
          }),
          ui: anomalias.length
            ? [
                bloqueRanking,
                {
                  tipo: "conductores",
                  items: anomalias.slice(0, 6).map((a) => ({
                    nombre: `${a.placa} · ${a.fecha}`,
                    estado: a.conductor || "sin conductor",
                    telefono: null,
                    alertas: [`${a.detalle} (${fmtSoles(a.monto)})`],
                  })),
                } as BloqueUI,
              ]
            : bloqueRanking,
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "finanzas": {
        const hoy = fechaLima();
        const inicioMes = hoy.slice(0, 8) + "01";

        if (input.tipo === "por_cobrar") {
          const { data } = await sb
            .from("facturas")
            .select("id, serie, numero, cliente_id, total, moneda, estado, fecha_emision, fecha_vencimiento")
            .in("estado", ["emitida", "enviada", "vencida"])
            .order("fecha_vencimiento", { ascending: true })
            .limit(50);
          const facturas = (data as any[]) ?? [];
          const total = facturas.reduce((s, f) => s + Number(f.total || 0), 0);
          const vencidas = facturas.filter((f) => (diasPara(f.fecha_vencimiento) ?? 1) < 0);
          const montoVencido = vencidas.reduce((s, f) => s + Number(f.total || 0), 0);
          const { count: porLiquidar } = await sb
            .from("reservas")
            .select("id", { count: "exact", head: true })
            .eq("estado", "finalizada")
            .eq("estado_admin", "por_liquidar");

          const clientes = await mapaNombres(sb, "clientes", facturas.map((f) => f.cliente_id), "id, nombre, empresa");
          return {
            paraModelo: JSON.stringify({
              total_por_cobrar: total,
              facturas_pendientes: facturas.length,
              facturas_vencidas: vencidas.length,
              monto_vencido: montoVencido,
              servicios_por_liquidar: porLiquidar ?? 0,
              detalle: facturas.slice(0, 15).map((f) => ({
                comprobante: `${f.serie}-${f.numero}`,
                cliente: f.cliente_id ? (clientes[f.cliente_id]?.nombre || clientes[f.cliente_id]?.empresa) : null,
                total: f.total,
                moneda: f.moneda,
                vence: f.fecha_vencimiento,
                estado: f.estado,
              })),
            }),
            ui: {
              tipo: "kpis",
              items: [
                { label: "Por cobrar", valor: fmtSoles(total), sub: `${facturas.length} facturas`, intent: "info" },
                { label: "Vencido", valor: fmtSoles(montoVencido), sub: `${vencidas.length} facturas`, intent: vencidas.length ? "danger" : "ok" },
                { label: "Por liquidar", valor: String(porLiquidar ?? 0), sub: "servicios finalizados", intent: (porLiquidar ?? 0) > 0 ? "warn" : "ok" },
              ],
            },
          };
        }

        if (input.tipo === "gastos") {
          const { data } = await sb
            .from("gastos")
            .select("categoria, monto")
            .gte("fecha", inicioMes)
            .neq("estado", "anulado");
          const filas = (data as any[]) ?? [];
          const porCat: Record<string, number> = {};
          for (const g of filas) porCat[g.categoria || "otro"] = (porCat[g.categoria || "otro"] || 0) + Number(g.monto || 0);
          const total = Object.values(porCat).reduce((s, n) => s + n, 0);
          const top = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 4);
          return {
            paraModelo: JSON.stringify({ mes_desde: inicioMes, total_gastos: total, por_categoria: porCat }),
            ui: {
              tipo: "kpis",
              items: [
                { label: "Gastos del mes", valor: fmtSoles(total), intent: "info" },
                ...top.slice(0, 3).map(([cat, m]) => ({ label: cat, valor: fmtSoles(m) })),
              ],
            },
          };
        }

        // resumen del mes
        const [{ data: resv }, { data: fact }, { data: gast }] = await Promise.all([
          sb.from("reservas").select("precio_cliente, margen, estado").gte("fecha_servicio", inicioMes).neq("estado", "cancelada"),
          sb.from("facturas").select("total, estado").gte("fecha_emision", inicioMes).neq("estado", "anulada"),
          sb.from("gastos").select("monto").gte("fecha", inicioMes).neq("estado", "anulado"),
        ]);
        const ventas = ((resv as any[]) ?? []).reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
        const margen = ((resv as any[]) ?? []).reduce((s, r) => s + Number(r.margen || 0), 0);
        const facturado = ((fact as any[]) ?? []).reduce((s, f) => s + Number(f.total || 0), 0);
        const gastos = ((gast as any[]) ?? []).reduce((s, g) => s + Number(g.monto || 0), 0);
        return {
          paraModelo: JSON.stringify({
            mes_desde: inicioMes,
            ventas_reservas: ventas,
            margen_reservas: margen,
            facturado_con_igv: facturado,
            gastos,
            servicios_mes: ((resv as any[]) ?? []).length,
          }),
          ui: {
            tipo: "kpis",
            items: [
              { label: "Ventas del mes", valor: fmtSoles(ventas), sub: `${((resv as any[]) ?? []).length} servicios`, intent: "info" },
              { label: "Facturado", valor: fmtSoles(facturado), intent: "ok" },
              { label: "Gastos", valor: fmtSoles(gastos), intent: "warn" },
              { label: "Margen", valor: fmtSoles(margen), intent: margen >= 0 ? "ok" : "danger" },
            ],
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "gps_en_vivo": {
        const desde = new Date(Date.now() - 30 * 60000).toISOString();
        const { data } = await sb
          .from("ubicaciones_gps")
          .select("vehiculo_id, vehiculo_tercero_id, conductor_id, conductor_tercero_id, reserva_id, lat, lng, velocidad, created_at, timestamp, fix_ts, estado")
          .gte("created_at", desde)
          .order("created_at", { ascending: false })
          .limit(400);
        const filas = (data as any[]) ?? [];

        // Dedupe por identidad estable (misma prioridad que /monitoreo)
        const porClave: Record<string, any> = {};
        for (const u of filas) {
          const clave = u.conductor_tercero_id
            ? `ct${u.conductor_tercero_id}`
            : u.conductor_id
            ? `c${u.conductor_id}`
            : u.vehiculo_tercero_id
            ? `vt${u.vehiculo_tercero_id}`
            : u.vehiculo_id
            ? `v${u.vehiculo_id}`
            : `r${u.reserva_id}`;
          if (!porClave[clave]) porClave[clave] = u; // primera = más reciente
        }
        const unidades = Object.values(porClave) as any[];

        const [vehiculos, vehiculosT, conductores, conductoresT] = await Promise.all([
          mapaNombres(sb, "vehiculos", unidades.map((u) => u.vehiculo_id), "id, placa"),
          mapaNombres(sb, "vehiculos_tercero", unidades.map((u) => u.vehiculo_tercero_id), "id, placa"),
          mapaNombres(sb, "conductores", unidades.map((u) => u.conductor_id), "id, nombre"),
          mapaNombres(sb, "conductores_tercero", unidades.map((u) => u.conductor_tercero_id), "id, nombre"),
        ]);

        let enLinea = 0, retraso = 0, sinSenal = 0;
        const detalle = unidades.map((u) => {
          const ts = u.fix_ts || u.timestamp || u.created_at;
          const min = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
          const señal = min <= 2 ? "en_linea" : min <= 10 ? "retraso" : "sin_senal";
          if (señal === "en_linea") enLinea++;
          else if (señal === "retraso") retraso++;
          else sinSenal++;
          return {
            placa: u.vehiculo_id ? vehiculos[u.vehiculo_id]?.placa : u.vehiculo_tercero_id ? vehiculosT[u.vehiculo_tercero_id]?.placa : null,
            conductor: u.conductor_id
              ? conductores[u.conductor_id]?.nombre
              : u.conductor_tercero_id
              ? conductoresT[u.conductor_tercero_id]?.nombre
              : null,
            reserva_id: u.reserva_id,
            velocidad_kmh: Math.round(Number(u.velocidad || 0)),
            hace_minutos: min,
            senal: señal,
          };
        });

        const { count: sos } = await sb.from("alertas_sos").select("id", { count: "exact", head: true }).eq("estado", "pendiente");

        return {
          paraModelo: JSON.stringify({ transmitiendo: unidades.length, en_linea: enLinea, con_retraso: retraso, sin_senal: sinSenal, sos_activos: sos ?? 0, unidades: detalle.slice(0, 20) }),
          ui: {
            tipo: "kpis",
            items: [
              { label: "En línea", valor: String(enLinea), intent: "ok" },
              { label: "Con retraso", valor: String(retraso), intent: retraso ? "warn" : "ok" },
              { label: "Sin señal", valor: String(sinSenal), intent: sinSenal ? "danger" : "ok" },
              { label: "SOS", valor: String(sos ?? 0), intent: (sos ?? 0) > 0 ? "danger" : "ok" },
            ],
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "rentabilidad": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const inicio = inicioMeses(meses);
        const hoy = fechaLima();
        const dimension: "ruta" | "cliente" | "tipo_servicio" =
          input.dimension === "cliente" || input.dimension === "tipo_servicio" ? input.dimension : "ruta";

        const filas = await fetchPaginado((d, h) =>
          sb
            .from("reservas")
            .select("id, origen, destino, cliente_id, tipo_servicio_detalle, precio_cliente, costo_proveedor, margen, estado")
            .gte("fecha_servicio", inicio)
            .lte("fecha_servicio", hoy)
            .neq("estado", "cancelada")
            .range(d, h)
        );
        if (filas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin servicios (no cancelados) en el rango." }) };

        const gastosFilas = await fetchPaginado((d, h) =>
          sb
            .from("gastos")
            .select("reserva_id, monto")
            .gte("fecha", inicio)
            .not("reserva_id", "is", null)
            .neq("estado", "anulado")
            .range(d, h)
        );
        const gastoPorReserva: Record<number, number> = {};
        for (const g of gastosFilas) gastoPorReserva[g.reserva_id] = (gastoPorReserva[g.reserva_id] || 0) + Number(g.monto || 0);

        const nombresCli =
          dimension === "cliente" ? await mapaNombres(sb, "clientes", filas.map((r) => r.cliente_id), "id, nombre, empresa") : {};

        const grupos: Record<string, { etiqueta: string; servicios: number; ventas: number; costo: number; gastos: number }> = {};
        for (const r of filas) {
          const etiqueta =
            dimension === "ruta"
              ? `${(r.origen || "?").trim()} → ${(r.destino || "?").trim()}`
              : dimension === "cliente"
              ? r.cliente_id
                ? nombresCli[r.cliente_id]?.nombre || nombresCli[r.cliente_id]?.empresa || `Cliente #${r.cliente_id}`
                : "(sin cliente)"
              : r.tipo_servicio_detalle || "(sin tipo)";
          const g = (grupos[etiqueta.toLowerCase()] ||= { etiqueta, servicios: 0, ventas: 0, costo: 0, gastos: 0 });
          g.servicios++;
          g.ventas += Number(r.precio_cliente || 0);
          g.costo += Number(r.costo_proveedor || 0);
          g.gastos += gastoPorReserva[r.id] || 0;
        }
        const lista = Object.values(grupos).map((g) => ({ ...g, margen_real: g.ventas - g.costo - g.gastos }));
        const top = [...lista].sort((a, b) => b.margen_real - a.margen_real).slice(0, 6);
        const enPerdida = lista.filter((g) => g.margen_real < 0).sort((a, b) => a.margen_real - b.margen_real).slice(0, 5);

        const aRanking = (l: typeof top): RankingUI[] =>
          l.map((g, i) => ({
            puesto: i + 1,
            nombre: g.etiqueta,
            valor: fmtSoles(g.margen_real),
            sub: `${g.servicios} serv · ventas ${fmtCorto(g.ventas)}${g.gastos ? ` · gastos ${fmtCorto(g.gastos)}` : ""}`,
          }));

        const bloques: BloqueUI[] = [{ tipo: "ranking", titulo: `Top ${dimension === "tipo_servicio" ? "tipos de servicio" : dimension + "s"} por margen real`, items: aRanking(top) }];
        if (enPerdida.length) bloques.push({ tipo: "ranking", titulo: "En pérdida (revisar)", items: aRanking(enPerdida) });

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            hasta: hoy,
            dimension,
            grupos_totales: lista.length,
            top,
            en_perdida: enPerdida,
            nota: "Margen real = precio_cliente − costo_proveedor − gastos con reserva_id asignada. Los gastos sin servicio asignado no se distribuyen.",
          }),
          ui: bloques,
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "desempeno_conductores": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const inicio = inicioMeses(meses);
        const hoy = fechaLima();

        let idsFiltro: number[] | null = null;
        if (input.nombre) {
          const { data } = await sb.from("conductores").select("id").ilike("nombre", `%${input.nombre}%`);
          idsFiltro = ((data as any[]) ?? []).map((c) => c.id);
          if (idsFiltro.length === 0)
            return { paraModelo: JSON.stringify({ encontrados: 0, nota: `No hay conductores con nombre parecido a "${input.nombre}".` }) };
        }

        const filas = await fetchPaginado((d, h) => {
          let q = sb
            .from("reservas")
            .select("conductor_id, fecha_servicio, hora_servicio, hora_real_inicio, hora_real_fin, estado")
            .gte("fecha_servicio", inicio)
            .lte("fecha_servicio", hoy)
            .not("conductor_id", "is", null)
            .neq("estado", "cancelada")
            .range(d, h);
          if (idsFiltro) q = q.in("conductor_id", idsFiltro);
          return q;
        });
        if (filas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin servicios con conductor propio asignado en el rango." }) };

        const acc: Record<number, { servicios: number; finalizados: number; conCheckin: number; tarde: number; retrasos: number[]; jornadas: number[] }> = {};
        for (const r of filas) {
          const a = (acc[r.conductor_id] ||= { servicios: 0, finalizados: 0, conCheckin: 0, tarde: 0, retrasos: [], jornadas: [] });
          a.servicios++;
          if (r.estado === "finalizada") a.finalizados++;
          const prog = minutosDe(r.hora_servicio);
          const real = minutosDe(r.hora_real_inicio);
          if (real !== null) a.conCheckin++;
          if (prog !== null && real !== null) {
            const retraso = real - prog;
            if (retraso > -120 && retraso < 600) {
              if (retraso > 15) {
                a.tarde++;
                a.retrasos.push(retraso);
              }
            }
          }
          const fin = minutosDe(r.hora_real_fin);
          if (real !== null && fin !== null) {
            const jornada = fin - real;
            if (jornada > 0 && jornada < 20 * 60) a.jornadas.push(jornada);
          }
        }

        const nombres = await mapaNombres(sb, "conductores", Object.keys(acc).map(Number), "id, nombre");
        const detalle = Object.entries(acc)
          .map(([id, a]) => ({
            conductor: nombres[Number(id)]?.nombre || `Conductor #${id}`,
            servicios: a.servicios,
            finalizados: a.finalizados,
            con_checkin: a.conCheckin,
            salidas_tarde: a.tarde,
            retraso_promedio_min: a.retrasos.length ? Math.round(a.retrasos.reduce((s, n) => s + n, 0) / a.retrasos.length) : null,
            jornada_promedio_horas: a.jornadas.length
              ? Math.round((a.jornadas.reduce((s, n) => s + n, 0) / a.jornadas.length / 60) * 10) / 10
              : null,
          }))
          .sort((x, y) => y.servicios - x.servicios);

        const bloques: BloqueUI[] = [
          {
            tipo: "ranking",
            titulo: "Conductores por servicios",
            items: detalle.slice(0, 6).map((c, i) => ({
              puesto: i + 1,
              nombre: c.conductor,
              valor: `${c.servicios} serv.`,
              sub: `${c.salidas_tarde} tarde${c.jornada_promedio_horas ? ` · jornada ~${c.jornada_promedio_horas}h` : ""}`,
            })),
          },
        ];
        const impuntuales = detalle.filter((c) => c.salidas_tarde >= 2).slice(0, 5);
        if (impuntuales.length)
          bloques.push({
            tipo: "conductores",
            items: impuntuales.map((c) => ({
              nombre: c.conductor,
              estado: `${c.servicios} servicios`,
              telefono: null,
              alertas: [`${c.salidas_tarde} salidas tarde (prom. +${c.retraso_promedio_min} min sobre la hora programada)`],
            })),
          });

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            hasta: hoy,
            conductores: detalle,
            nota: "Retraso = hora_real_inicio (check-in) vs hora_servicio programada, umbral 15 min; solo cuenta servicios con check-in registrado. Presenta los retrasos como tema a conversar con el conductor, no como falta comprobada (puede haber causas operativas).",
          }),
          ui: bloques,
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "utilizacion_flota": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const inicio = inicioMeses(meses);
        const hoy = fechaLima();

        const [{ data: vehs }, filas, lecturas] = await Promise.all([
          sb.from("vehiculos").select("id, placa, categoria, estado"),
          fetchPaginado((d, h) =>
            sb
              .from("reservas")
              .select("vehiculo_id, vehiculo_tercero_id, tipo_asignacion, fecha_servicio, estado")
              .gte("fecha_servicio", inicio)
              .lte("fecha_servicio", hoy)
              .neq("estado", "cancelada")
              .range(d, h)
          ),
          fetchPaginado((d, h) =>
            sb
              .from("lecturas_odometro")
              .select("vehiculo_id, km, fecha")
              .not("vehiculo_id", "is", null)   // solo flota propia (terceros tienen vehiculo_id NULL)
              .gte("fecha", inicio)
              .eq("estado", "aceptada")
              .range(d, h)
          ),
        ]);
        const vehiculos = (vehs as any[]) ?? [];
        if (filas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin servicios en el rango." }) };

        const kmPorVeh: Record<number, { min: number; max: number }> = {};
        for (const l of lecturas) {
          const k = (kmPorVeh[l.vehiculo_id] ||= { min: Number(l.km), max: Number(l.km) });
          k.min = Math.min(k.min, Number(l.km));
          k.max = Math.max(k.max, Number(l.km));
        }

        const uso: Record<number, { servicios: number; dias: Set<string> }> = {};
        let tercerizados = 0;
        for (const r of filas) {
          if (r.tipo_asignacion === "tercerizado" || r.vehiculo_tercero_id) tercerizados++;
          if (r.vehiculo_id) {
            const u = (uso[r.vehiculo_id] ||= { servicios: 0, dias: new Set() });
            u.servicios++;
            u.dias.add(r.fecha_servicio);
          }
        }
        const pctTerceros = Math.round((tercerizados / filas.length) * 100);

        const porUnidad = vehiculos
          .map((v) => ({
            placa: v.placa,
            categoria: v.categoria,
            estado: v.estado,
            servicios: uso[v.id]?.servicios || 0,
            dias_activos: uso[v.id]?.dias.size || 0,
            km_recorridos: kmPorVeh[v.id] ? Math.max(0, kmPorVeh[v.id].max - kmPorVeh[v.id].min) : null,
          }))
          .sort((a, b) => b.servicios - a.servicios);
        const ociosas = porUnidad.filter((u) => u.servicios === 0 && u.estado !== "inactivo");

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            hasta: hoy,
            servicios_totales: filas.length,
            tercerizados,
            pct_tercerizado: pctTerceros,
            por_unidad: porUnidad,
            unidades_sin_uso: ociosas.map((u) => u.placa),
          }),
          ui: [
            {
              tipo: "kpis",
              items: [
                { label: "Servicios", valor: String(filas.length), sub: `desde ${inicio}`, intent: "info" },
                { label: "Tercerizados", valor: `${pctTerceros}%`, sub: `${tercerizados} servicios`, intent: pctTerceros > 40 ? "warn" : "ok" },
                { label: "Unidades sin uso", valor: String(ociosas.length), sub: ociosas.slice(0, 3).map((u) => u.placa).join(", ") || undefined, intent: ociosas.length ? "warn" : "ok" },
              ],
            },
            {
              tipo: "ranking",
              titulo: "Unidades más utilizadas",
              items: porUnidad.slice(0, 5).map((u, i) => ({
                puesto: i + 1,
                nombre: u.placa,
                valor: `${u.servicios} serv.`,
                sub: `${u.dias_activos} días activos${u.km_recorridos ? ` · ${u.km_recorridos.toLocaleString("es-PE")} km` : ""}`,
              })),
            },
          ],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "analisis_cotizaciones": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const inicio = inicioMeses(meses);

        const filas = await fetchPaginado((d, h) =>
          sb
            .from("cotizaciones")
            .select("id, numero_cotizacion, estado, precio_cliente, cliente_id, created_at, origen, destino, descuento_solicitado")
            .gte("created_at", inicio)
            .range(d, h)
        );
        if (filas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin cotizaciones creadas en el rango." }) };

        const porEstado: Record<string, number> = {};
        for (const c of filas) porEstado[c.estado || "borrador"] = (porEstado[c.estado || "borrador"] || 0) + 1;
        const aprobadas = porEstado["aprobado"] || 0;
        const rechazadas = porEstado["rechazado"] || 0;
        const enviadas = porEstado["enviado"] || 0;
        const decididas = aprobadas + rechazadas + enviadas;
        const tasaCierre = decididas > 0 ? Math.round((aprobadas / decididas) * 100) : 0;
        const montoCotizado = filas.reduce((s, c) => s + Number(c.precio_cliente || 0), 0);
        const montoAprobado = filas.filter((c) => c.estado === "aprobado").reduce((s, c) => s + Number(c.precio_cliente || 0), 0);

        const sinRespuesta = filas
          .filter((c) => c.estado === "enviado")
          .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
          .slice(0, 5);
        const nombresCli = await mapaNombres(sb, "clientes", sinRespuesta.map((c) => c.cliente_id), "id, nombre, empresa");
        const pendientes = sinRespuesta.map((c) => ({
          numero: c.numero_cotizacion,
          cliente: c.cliente_id ? nombresCli[c.cliente_id]?.nombre || nombresCli[c.cliente_id]?.empresa : null,
          ruta: `${c.origen ?? "?"} → ${c.destino ?? "?"}`,
          monto: Math.round(Number(c.precio_cliente || 0) * 100) / 100,
          dias_esperando: Math.max(0, Math.floor((Date.now() - new Date(c.created_at).getTime()) / 86400000)),
        }));

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            total: filas.length,
            por_estado: porEstado,
            tasa_cierre_pct: tasaCierre,
            monto_cotizado: Math.round(montoCotizado),
            monto_aprobado: Math.round(montoAprobado),
            enviadas_sin_respuesta: pendientes,
            nota: "Tasa de cierre = aprobadas / (aprobadas + rechazadas + enviadas sin respuesta). Sugiere hacer seguimiento a las enviadas con más días de espera.",
          }),
          ui: {
            tipo: "kpis",
            items: [
              { label: "Cotizadas", valor: String(filas.length), sub: `desde ${inicio}`, intent: "info" },
              { label: "Tasa de cierre", valor: `${tasaCierre}%`, sub: `${aprobadas} aprobadas`, intent: tasaCierre >= 40 ? "ok" : "warn" },
              { label: "Sin respuesta", valor: String(enviadas), sub: "enviadas en espera", intent: enviadas > 0 ? "warn" : "ok" },
              { label: "Monto aprobado", valor: fmtCorto(montoAprobado), sub: `de ${fmtCorto(montoCotizado)} cotizado`, intent: "ok" },
            ],
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "ocupacion_servicios": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const inicio = inicioMeses(meses);
        const hoy = fechaLima();

        let q = (d: number, h: number) =>
          sb
            .from("reservas")
            .select("id, origen, destino, cliente_id, fecha_servicio")
            .gte("fecha_servicio", inicio)
            .lte("fecha_servicio", hoy)
            .neq("estado", "cancelada")
            .range(d, h);
        if (input.cliente_nombre) {
          const { data: clis } = await sb
            .from("clientes")
            .select("id")
            .or(`nombre.ilike.%${input.cliente_nombre}%,empresa.ilike.%${input.cliente_nombre}%`)
            .limit(20);
          const ids = ((clis as any[]) ?? []).map((c) => c.id);
          if (ids.length === 0)
            return { paraModelo: JSON.stringify({ encontrados: 0, nota: `No encontré clientes con "${input.cliente_nombre}".` }) };
          const qBase = q;
          q = (d, h) => qBase(d, h).in("cliente_id", ids);
        }
        const reservas = await fetchPaginado(q);
        if (reservas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin servicios en el rango." }) };

        // Ocupación por tramos de 150 ids (la vista se consulta por reserva_id)
        const porReserva: Record<number, any> = {};
        for (let i = 0; i < reservas.length; i += 150) {
          const ids = reservas.slice(i, i + 150).map((r) => r.id);
          const { data } = await sb.from("reservas_ocupacion").select("*").in("reserva_id", ids);
          for (const o of (data as any[]) ?? []) porReserva[o.reserva_id] = o;
        }

        const conDatos = reservas
          .map((r) => ({ r, o: porReserva[r.id] }))
          .filter((x) => x.o && Number(x.o.capacidad) > 0 && Number(x.o.total_pasajeros) > 0);
        if (conDatos.length === 0)
          return {
            paraModelo: JSON.stringify({
              encontrados: reservas.length,
              nota: "Hay servicios en el rango pero ninguno tiene pasajeros y capacidad registrados; la ocupación no se puede medir todavía.",
            }),
          };

        const pctDe = (o: any) =>
          o.ocupacion_pct != null ? Number(o.ocupacion_pct) : Math.round((Number(o.total_pasajeros) / Number(o.capacidad)) * 100);
        let suma = 0, sobrecupos = 0, bajos = 0;
        const rutas: Record<string, { etiqueta: string; suma: number; n: number }> = {};
        for (const { r, o } of conDatos) {
          const pct = pctDe(o);
          suma += pct;
          if (o.sobrecupo || pct > 100) sobrecupos++;
          if (pct < 50) bajos++;
          const etiqueta = `${(r.origen || "?").trim()} → ${(r.destino || "?").trim()}`;
          const g = (rutas[etiqueta.toLowerCase()] ||= { etiqueta, suma: 0, n: 0 });
          g.suma += pct;
          g.n++;
        }
        const promedio = Math.round(suma / conDatos.length);
        const rutasBajas = Object.values(rutas)
          .filter((g) => g.n >= 2)
          .map((g) => ({ ruta: g.etiqueta, ocupacion_pct: Math.round(g.suma / g.n), servicios: g.n }))
          .sort((a, b) => a.ocupacion_pct - b.ocupacion_pct)
          .slice(0, 5);

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            hasta: hoy,
            servicios_medidos: conDatos.length,
            ocupacion_promedio_pct: promedio,
            sobrecupos,
            servicios_baja_ocupacion: bajos,
            rutas_menor_ocupacion: rutasBajas,
            nota: "Baja ocupación sostenida en una ruta = oportunidad de usar una unidad más chica o consolidar horarios.",
          }),
          ui: [
            {
              tipo: "kpis",
              items: [
                { label: "Ocupación promedio", valor: `${promedio}%`, sub: `${conDatos.length} servicios medidos`, intent: promedio >= 70 ? "ok" : "warn" },
                { label: "Sobrecupos", valor: String(sobrecupos), intent: sobrecupos ? "danger" : "ok" },
                { label: "Baja ocupación", valor: String(bajos), sub: "servicios <50%", intent: bajos ? "warn" : "ok" },
              ],
            },
            ...(rutasBajas.length
              ? [
                  {
                    tipo: "ranking",
                    titulo: "Rutas con menor ocupación",
                    items: rutasBajas.map((g, i) => ({
                      puesto: i + 1,
                      nombre: g.ruta,
                      valor: `${g.ocupacion_pct}%`,
                      sub: `${g.servicios} servicios`,
                    })),
                  } as BloqueUI,
                ]
              : []),
          ],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "tendencia_mensual": {
        const meses = Math.min(Math.max(Number(input.meses) || 6, 2), 12);
        const inicio = inicioMeses(meses);
        const hoy = fechaLima();

        const [reservas, gastos, facturas] = await Promise.all([
          fetchPaginado((d, h) =>
            sb
              .from("reservas")
              .select("fecha_servicio, precio_cliente, margen, estado")
              .gte("fecha_servicio", inicio)
              .lte("fecha_servicio", hoy)
              .neq("estado", "cancelada")
              .range(d, h)
          ),
          fetchPaginado((d, h) =>
            sb.from("gastos").select("fecha, monto").gte("fecha", inicio).neq("estado", "anulado").range(d, h)
          ),
          fetchPaginado((d, h) =>
            sb.from("facturas").select("fecha_emision, total").gte("fecha_emision", inicio).neq("estado", "anulada").range(d, h)
          ),
        ]);

        const porMes: Record<string, { servicios: number; ventas: number; margen: number; gastos: number; facturado: number }> = {};
        const mesDe = (f?: string | null) => (f ? String(f).slice(0, 7) : null);
        const celda = (m: string) => (porMes[m] ||= { servicios: 0, ventas: 0, margen: 0, gastos: 0, facturado: 0 });
        for (const r of reservas) {
          const m = mesDe(r.fecha_servicio);
          if (!m) continue;
          const c = celda(m);
          c.servicios++;
          c.ventas += Number(r.precio_cliente || 0);
          c.margen += Number(r.margen || 0);
        }
        for (const g of gastos) {
          const m = mesDe(g.fecha);
          if (m) celda(m).gastos += Number(g.monto || 0);
        }
        for (const f of facturas) {
          const m = mesDe(f.fecha_emision);
          if (m) celda(m).facturado += Number(f.total || 0);
        }

        const mesesOrden = Object.keys(porMes).sort();
        if (mesesOrden.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin actividad registrada en el rango." }) };

        const tabla = mesesOrden.map((m) => ({ mes: m, ...porMes[m] }));
        const actual = tabla[tabla.length - 1];
        const anterior = tabla.length > 1 ? tabla[tabla.length - 2] : null;
        const variacion = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : a > 0 ? 100 : 0);

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            hasta: hoy,
            por_mes: tabla.map((t) => ({
              ...t,
              ventas: Math.round(t.ventas),
              margen: Math.round(t.margen),
              gastos: Math.round(t.gastos),
              facturado: Math.round(t.facturado),
            })),
            mes_actual_vs_anterior: anterior
              ? {
                  ventas_pct: variacion(actual.ventas, anterior.ventas),
                  servicios_pct: variacion(actual.servicios, anterior.servicios),
                  gastos_pct: variacion(actual.gastos, anterior.gastos),
                  nota_parcial: `El mes en curso (${actual.mes}) aún no termina: compara con cuidado.`,
                }
              : null,
          }),
          ui: [
            {
              tipo: "serie",
              titulo: `Ventas por mes (últimos ${mesesOrden.length})`,
              items: tabla.map((t) => ({
                label: MES_CORTO[Number(t.mes.slice(5, 7)) - 1] ?? t.mes.slice(5, 7),
                valor: t.ventas,
                etiqueta: fmtCorto(t.ventas),
              })),
            },
            ...(anterior
              ? [
                  {
                    tipo: "kpis",
                    items: [
                      {
                        label: "Ventas vs mes anterior",
                        valor: `${variacion(actual.ventas, anterior.ventas) > 0 ? "+" : ""}${variacion(actual.ventas, anterior.ventas)}%`,
                        sub: "mes en curso, parcial",
                        intent: variacion(actual.ventas, anterior.ventas) >= 0 ? "ok" : "danger",
                      },
                      { label: "Servicios", valor: String(actual.servicios), sub: `antes ${anterior.servicios}` },
                      { label: "Gastos", valor: fmtCorto(actual.gastos), sub: `antes ${fmtCorto(anterior.gastos)}`, intent: "warn" },
                      { label: "Margen", valor: fmtCorto(actual.margen), intent: actual.margen >= 0 ? "ok" : "danger" },
                    ],
                  } as BloqueUI,
                ]
              : []),
          ],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_multas": {
        const meses = Math.min(Math.max(Number(input.meses) || 3, 1), 12);
        const inicio = inicioMeses(meses);
        let q = sb
          .from("multas")
          .select(
            "id, placa, conductor_nombre, entidad, infraccion, severidad, puntos, monto_original, tiene_pronto_pago, monto_pronto_pago, fecha_limite_pronto_pago, fecha_infraccion, fecha_vencimiento, estado"
          )
          .gte("fecha_infraccion", inicio);
        if (input.estado) q = q.eq("estado", input.estado);
        if (input.placa) q = q.ilike("placa", `%${input.placa}%`);
        const { data } = await q.order("fecha_infraccion", { ascending: false }).limit(200);
        const multas = (data as any[]) ?? [];
        if (multas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin multas registradas con esos filtros." }) };

        const pendientes = multas.filter((m) => m.estado === "Pendiente");
        const montoPendiente = pendientes.reduce((s, m) => s + Number(m.monto_original || 0), 0);
        const prontoPago = pendientes
          .filter((m) => m.tiene_pronto_pago && m.fecha_limite_pronto_pago && (diasPara(m.fecha_limite_pronto_pago) ?? -1) >= 0)
          .map((m) => ({
            placa: m.placa,
            infraccion: m.infraccion,
            dias_restantes: diasPara(m.fecha_limite_pronto_pago),
            pagar: Number(m.monto_pronto_pago || 0),
            ahorro: Number(m.monto_original || 0) - Number(m.monto_pronto_pago || 0),
          }))
          .sort((a, b) => (a.dias_restantes ?? 0) - (b.dias_restantes ?? 0));
        const ahorroTotal = prontoPago.reduce((s, m) => s + m.ahorro, 0);
        const porVencer = pendientes.filter((m) => {
          const d = diasPara(m.fecha_vencimiento);
          return d !== null && d >= 0 && d <= 5;
        });

        const puntosPorConductor: Record<string, number> = {};
        for (const m of multas)
          if (m.conductor_nombre) puntosPorConductor[m.conductor_nombre] = (puntosPorConductor[m.conductor_nombre] || 0) + Number(m.puntos || 0);

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            total: multas.length,
            pendientes: pendientes.length,
            monto_pendiente: montoPendiente,
            pronto_pago_activo: prontoPago,
            ahorro_si_paga_a_tiempo: ahorroTotal,
            por_vencer_5dias: porVencer.length,
            puntos_por_conductor: puntosPorConductor,
            detalle: multas.slice(0, 12).map((m) => ({
              placa: m.placa,
              fecha: m.fecha_infraccion,
              infraccion: m.infraccion,
              severidad: m.severidad,
              monto: m.monto_original,
              estado: m.estado,
              entidad: m.entidad,
            })),
            nota: "Prioriza avisar los pronto pago por vencer: pagarlos a tiempo es ahorro directo. 100 puntos acumulados en la flota = riesgo de suspensión SUTRAN.",
          }),
          ui: {
            tipo: "kpis",
            items: [
              { label: "Pendientes", valor: String(pendientes.length), sub: fmtSoles(montoPendiente), intent: pendientes.length ? "warn" : "ok" },
              { label: "Pronto pago activo", valor: String(prontoPago.length), sub: prontoPago.length ? `ahorra ${fmtSoles(ahorroTotal)}` : undefined, intent: prontoPago.length ? "danger" : "ok" },
              { label: "Vencen en ≤5 días", valor: String(porVencer.length), intent: porVencer.length ? "danger" : "ok" },
              { label: "Multas en el período", valor: String(multas.length), sub: `desde ${inicio}`, intent: "info" },
            ],
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_incidencias": {
        const meses = Math.min(Math.max(Number(input.meses) || 1, 1), 12);
        const inicio = inicioMeses(meses);
        const soloAbiertas = input.solo_abiertas !== false;

        let q = sb
          .from("incidencias")
          .select("id, tipo, severidad, estado, descripcion, ubicacion, vehiculo_id, conductor_id, cliente, impacto_economico, sla_limite_h, tiempo_resolucion_h, created_at")
          .gte("created_at", inicio);
        if (input.severidad) q = q.eq("severidad", input.severidad);
        if (soloAbiertas) q = q.neq("estado", "cerrado");
        const { data } = await q.order("created_at", { ascending: false }).limit(100);
        const incidencias = (data as any[]) ?? [];
        if (incidencias.length === 0)
          return {
            paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: soloAbiertas ? "No hay incidencias abiertas en el rango. 🎉" : "Sin incidencias en el rango." }),
          };

        const vehiculos = await mapaNombres(sb, "vehiculos", incidencias.map((i) => i.vehiculo_id), "id, placa");
        const porTipo: Record<string, number> = {};
        const porSeveridad: Record<string, number> = {};
        let slaVencidos = 0;
        let impacto = 0;
        const detalle = incidencias.map((i) => {
          porTipo[i.tipo] = (porTipo[i.tipo] || 0) + 1;
          porSeveridad[i.severidad] = (porSeveridad[i.severidad] || 0) + 1;
          impacto += Number(i.impacto_economico || 0);
          const horas = Math.floor((Date.now() - new Date(i.created_at).getTime()) / 3600000);
          const slaVencido = i.estado !== "cerrado" && i.sla_limite_h && horas > Number(i.sla_limite_h);
          if (slaVencido) slaVencidos++;
          return {
            tipo: i.tipo,
            severidad: i.severidad,
            estado: i.estado,
            placa: i.vehiculo_id ? vehiculos[i.vehiculo_id]?.placa : null,
            descripcion: (i.descripcion || "").slice(0, 120),
            horas_abierta: i.estado !== "cerrado" ? horas : null,
            sla_vencido: !!slaVencido,
          };
        });

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            encontrados: incidencias.length,
            por_tipo: porTipo,
            por_severidad: porSeveridad,
            sla_vencidos: slaVencidos,
            impacto_economico_total: impacto,
            detalle: detalle.slice(0, 12),
          }),
          ui: [
            {
              tipo: "kpis",
              items: [
                { label: soloAbiertas ? "Abiertas" : "Incidencias", valor: String(incidencias.length), sub: `desde ${inicio}`, intent: "info" },
                { label: "SLA vencido", valor: String(slaVencidos), intent: slaVencidos ? "danger" : "ok" },
                { label: "Críticas/altas", valor: String((porSeveridad["critico"] || 0) + (porSeveridad["alto"] || 0)), intent: (porSeveridad["critico"] || 0) > 0 ? "danger" : "warn" },
                { label: "Impacto económico", valor: fmtCorto(impacto), intent: impacto > 0 ? "warn" : "ok" },
              ],
            },
            {
              tipo: "conductores",
              items: detalle.slice(0, 6).map((d) => ({
                nombre: `${d.tipo}${d.placa ? ` · ${d.placa}` : ""}`,
                estado: `${d.severidad} · ${d.estado}`,
                telefono: null,
                alertas: [
                  ...(d.sla_vencido ? [`SLA VENCIDO (${d.horas_abierta}h abierta)`] : []),
                  ...(d.descripcion ? [d.descripcion] : []),
                ],
              })),
            } as BloqueUI,
          ],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_neumaticos": {
        let q = sb
          .from("neumaticos")
          .select("id, vehiculo_id, marca, medida, posicion, km_actual, km_instalacion, vida_util_km, cocada_actual, cocada_nueva, costo_compra, estado");
        const { data } = await q.limit(300);
        let neumaticos = (data as any[]) ?? [];
        if (input.placa) {
          const { data: v } = await sb.from("vehiculos").select("id").ilike("placa", `%${input.placa}%`);
          const ids = new Set(((v as any[]) ?? []).map((x) => x.id));
          neumaticos = neumaticos.filter((n) => ids.has(n.vehiculo_id));
        }
        if (neumaticos.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, nota: "Sin neumáticos registrados con ese filtro." }) };

        const vehiculos = await mapaNombres(sb, "vehiculos", neumaticos.map((n) => n.vehiculo_id), "id, placa");
        const detalle = neumaticos.map((n) => {
          const kmRec = Math.max(0, Number(n.km_actual || 0) - Number(n.km_instalacion || 0));
          const vida = Number(n.vida_util_km || 80000);
          const pct = Math.min(100, Math.round((kmRec / vida) * 100));
          const cpk = kmRec > 0 && Number(n.costo_compra) > 0 ? Number(n.costo_compra) / kmRec : null;
          return {
            placa: n.vehiculo_id ? vehiculos[n.vehiculo_id]?.placa : null,
            posicion: n.posicion,
            marca: n.marca,
            medida: n.medida,
            km_recorridos: kmRec,
            vida_util_pct: pct,
            cocada_mm: n.cocada_actual,
            cpk: cpk ? Math.round(cpk * 1000) / 1000 : null,
            estado: n.estado,
            nivel: pct >= 90 ? "critico" : pct >= 70 ? "observacion" : "ok",
          };
        });
        const criticos = detalle.filter((d) => d.nivel === "critico");
        const observacion = detalle.filter((d) => d.nivel === "observacion");
        const visibles = input.solo_alertas ? [...criticos, ...observacion] : detalle;

        return {
          paraModelo: JSON.stringify({
            encontrados: detalle.length,
            criticos: criticos.length,
            en_observacion: observacion.length,
            detalle: visibles.slice(0, 15),
            nota: "Crítico = ≥90% de la vida útil en km; observación = 70-90%. Cambiar a tiempo evita fallas en ruta.",
          }),
          ui: [
            {
              tipo: "kpis",
              items: [
                { label: "Neumáticos", valor: String(detalle.length), intent: "info" },
                { label: "Críticos (≥90%)", valor: String(criticos.length), intent: criticos.length ? "danger" : "ok" },
                { label: "En observación", valor: String(observacion.length), sub: "70-90% de vida útil", intent: observacion.length ? "warn" : "ok" },
              ],
            },
            ...(criticos.length + observacion.length > 0
              ? [
                  {
                    tipo: "conductores",
                    items: [...criticos, ...observacion].slice(0, 6).map((d) => ({
                      nombre: `${d.placa ?? "?"} · pos. ${d.posicion ?? "?"}`,
                      estado: `${d.vida_util_pct}% usado`,
                      telefono: null,
                      alertas: [
                        `${d.nivel === "critico" ? "VENCIDO/crítico" : "En observación"}: ${d.km_recorridos.toLocaleString("es-PE")} km recorridos${d.cocada_mm ? ` · cocada ${d.cocada_mm}mm` : ""}`,
                      ],
                    })),
                  } as BloqueUI,
                ]
              : []),
          ],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_seguros": {
        const { data } = await sb
          .from("seguros")
          .select("id, tipo, aseguradora, numero_poliza, vehiculo_id, proveedor_id, fecha_vencimiento, prima_total, cuota_mensual, estado")
          .limit(200);
        const seguros = (data as any[]) ?? [];
        if (seguros.length === 0) return { paraModelo: JSON.stringify({ encontrados: 0, nota: "No hay pólizas registradas." }) };

        const ETIQUETA_TIPO: Record<string, string> = {
          soat: "SOAT",
          cat: "CAT",
          sctr_salud: "SCTR Salud",
          sctr_pension: "SCTR Pensión",
          vida_ley: "Vida Ley",
          todo_riesgo: "Todo Riesgo",
          responsabilidad_civil: "Resp. Civil",
          seguro_carga: "Seg. Carga",
          patrimonio: "Patrimonio",
          otro: "Otro",
        };
        const OBLIGATORIOS = new Set(["soat", "cat", "sctr_salud", "sctr_pension", "vida_ley"]);
        const vehiculos = await mapaNombres(sb, "vehiculos", seguros.map((s) => s.vehiculo_id), "id, placa");

        const detalle = seguros.map((s) => {
          const dias = diasPara(s.fecha_vencimiento);
          return {
            tipo: ETIQUETA_TIPO[s.tipo] || s.tipo,
            obligatorio: OBLIGATORIOS.has(s.tipo),
            aseguradora: s.aseguradora,
            poliza: s.numero_poliza,
            placa: s.vehiculo_id ? vehiculos[s.vehiculo_id]?.placa : null,
            vence: s.fecha_vencimiento,
            dias_para_vencer: dias,
            situacion: dias === null ? "sin_fecha" : dias < 0 ? "vencido" : dias <= 30 ? "por_vencer" : "vigente",
            cuota_mensual: s.cuota_mensual,
          };
        });
        const vencidos = detalle.filter((d) => d.situacion === "vencido");
        const porVencer = detalle.filter((d) => d.situacion === "por_vencer");
        const cuotaTotal = seguros.reduce((s, x) => s + Number(x.cuota_mensual || 0), 0);
        const visibles = input.solo_alertas ? [...vencidos, ...porVencer] : detalle;

        return {
          paraModelo: JSON.stringify({
            encontrados: detalle.length,
            vencidos: vencidos.length,
            por_vencer_30d: porVencer.length,
            cuota_mensual_total: cuotaTotal,
            detalle: visibles.slice(0, 15),
            nota: "SOAT/CAT, SCTR y Vida Ley son obligatorios por ley: un vencido es riesgo legal inmediato.",
          }),
          ui: [
            {
              tipo: "kpis",
              items: [
                { label: "Pólizas", valor: String(detalle.length), intent: "info" },
                { label: "Vencidas", valor: String(vencidos.length), intent: vencidos.length ? "danger" : "ok" },
                { label: "Por vencer (30d)", valor: String(porVencer.length), intent: porVencer.length ? "warn" : "ok" },
                { label: "Cuota mensual", valor: fmtCorto(cuotaTotal), intent: "info" },
              ],
            },
            ...(vencidos.length + porVencer.length > 0
              ? [
                  {
                    tipo: "conductores",
                    items: [...vencidos, ...porVencer].slice(0, 6).map((d) => ({
                      nombre: `${d.tipo}${d.placa ? ` · ${d.placa}` : ""}`,
                      estado: d.aseguradora,
                      telefono: null,
                      alertas: [
                        d.situacion === "vencido"
                          ? `VENCIDO hace ${Math.abs(d.dias_para_vencer!)} día(s)${d.obligatorio ? " (OBLIGATORIO)" : ""}`
                          : `Vence en ${d.dias_para_vencer} día(s)${d.obligatorio ? " (obligatorio)" : ""}`,
                      ],
                    })),
                  } as BloqueUI,
                ]
              : []),
          ],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_mantenimiento": {
        const meses = Math.min(Math.max(Number(input.meses) || 3, 1), 12);
        const inicio = inicioMeses(meses);
        const hoy = fechaLima();

        const [{ data: ots }, { data: mants }, { data: vehs }] = await Promise.all([
          sb
            .from("ordenes_trabajo")
            .select("id, vehiculo_id, fecha_apertura, fecha_cierre, mecanico, taller, costo_total, estado")
            .gte("fecha_apertura", inicio)
            .order("fecha_apertura", { ascending: false })
            .limit(100),
          sb
            .from("mantenimiento")
            .select("id, vehiculo_id, fecha, tipo, descripcion, costo, estado, proximo_km, proxima_fecha")
            .gte("fecha", inicio)
            .order("fecha", { ascending: false })
            .limit(150),
          sb.from("vehiculos").select("id, placa, kilometraje_actual, proximo_mantenimiento_km"),
        ]);
        const vehiculos: Record<number, any> = {};
        for (const v of (vehs as any[]) ?? []) vehiculos[v.id] = v;

        const otsAbiertas = ((ots as any[]) ?? []).filter((o) => o.estado === "abierta" || o.estado === "en_proceso");
        const costoOts = ((ots as any[]) ?? []).filter((o) => o.estado === "cerrada").reduce((s, o) => s + Number(o.costo_total || 0), 0);
        const costoMants = ((mants as any[]) ?? []).filter((m) => m.estado === "finalizado").reduce((s, m) => s + Number(m.costo || 0), 0);
        const pendientes = ((mants as any[]) ?? []).filter((m) => m.estado === "pendiente" || m.estado === "en_proceso");

        // Próximos por km (usando el consolidado del vehículo) y por fecha
        const proximos: { placa: string; detalle: string }[] = [];
        for (const v of (vehs as any[]) ?? []) {
          if (v.proximo_mantenimiento_km && v.kilometraje_actual) {
            const faltan = Number(v.proximo_mantenimiento_km) - Number(v.kilometraje_actual);
            if (faltan <= 500)
              proximos.push({ placa: v.placa, detalle: faltan < 0 ? `VENCIDO por ${Math.abs(faltan)} km` : `en ${faltan} km` });
          }
        }
        for (const m of (mants as any[]) ?? []) {
          const dias = diasPara(m.proxima_fecha);
          if (dias !== null && dias <= 15) {
            const placa = m.vehiculo_id ? vehiculos[m.vehiculo_id]?.placa : "?";
            proximos.push({ placa, detalle: dias < 0 ? `VENCIDO hace ${Math.abs(dias)} día(s)` : `en ${dias} día(s)` });
          }
        }

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            ots_abiertas: otsAbiertas.map((o) => ({
              placa: o.vehiculo_id ? vehiculos[o.vehiculo_id]?.placa : null,
              taller: o.taller,
              mecanico: o.mecanico,
              dias_abierta: Math.max(0, Math.floor((Date.now() - new Date(o.fecha_apertura + "T00:00:00-05:00").getTime()) / 86400000)),
              estado: o.estado,
            })),
            mantenimientos_pendientes: pendientes.length,
            proximos_mantenimientos: proximos,
            costo_periodo: Math.round((costoOts + costoMants) * 100) / 100,
          }),
          ui: {
            tipo: "kpis",
            items: [
              { label: "OTs abiertas", valor: String(otsAbiertas.length), intent: otsAbiertas.length ? "warn" : "ok" },
              { label: "Próximos", valor: String(proximos.length), sub: "por km o fecha", intent: proximos.length ? "warn" : "ok" },
              { label: "Pendientes", valor: String(pendientes.length), intent: pendientes.length ? "warn" : "ok" },
              { label: "Costo del período", valor: fmtCorto(costoOts + costoMants), sub: `desde ${inicio}`, intent: "info" },
            ],
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "buscar_pasajero": {
        const b = String(input.busqueda || "").trim();
        if (!b) return { paraModelo: JSON.stringify({ error: "Falta el texto de búsqueda." }) };
        const { data } = await sb
          .from("pasajeros")
          .select("id, nombre, dni, empresa, cliente_id, telefono, email, activo")
          .or(`nombre.ilike.%${b}%,dni.ilike.%${b}%,empresa.ilike.%${b}%`)
          .limit(8);
        const pasajeros = (data as any[]) ?? [];
        if (pasajeros.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, nota: `No encontré pasajeros que coincidan con "${b}".` }) };

        // Últimas asignaciones del primer match
        const principal = pasajeros[0];
        const { data: pp } = await sb
          .from("pasajeros_parada")
          .select("id, parada_id, estado, estado_abordaje")
          .eq("pasajero_id", principal.id)
          .order("id", { ascending: false })
          .limit(6);
        const asignaciones = (pp as any[]) ?? [];
        let viajes: any[] = [];
        if (asignaciones.length > 0) {
          const { data: paradas } = await sb
            .from("paradas")
            .select("id, reserva_id, nombre, hora_estimada")
            .in("id", asignaciones.map((a) => a.parada_id));
          const paradaPorId: Record<number, any> = {};
          for (const p of (paradas as any[]) ?? []) paradaPorId[p.id] = p;
          const reservaIds = [...new Set(((paradas as any[]) ?? []).map((p) => p.reserva_id).filter(Boolean))];
          const reservas = await mapaNombres(sb, "reservas", reservaIds, "id, origen, destino, fecha_servicio, estado");
          viajes = asignaciones.map((a) => {
            const parada = paradaPorId[a.parada_id];
            const r = parada ? reservas[parada.reserva_id] : null;
            const abordado = a.estado_abordaje === "Abordado" || a.estado === "abordado" || a.estado === "embarcado";
            return {
              servicio_id: r?.id ?? null,
              fecha: r?.fecha_servicio ?? null,
              ruta: r ? `${r.origen ?? "?"} → ${r.destino ?? "?"}` : null,
              paradero: parada?.nombre ?? null,
              hora_paradero: parada?.hora_estimada ?? null,
              abordo: abordado,
            };
          });
        }

        return {
          paraModelo: JSON.stringify({
            encontrados: pasajeros.length,
            pasajeros: pasajeros.map((p) => ({ nombre: p.nombre, dni: p.dni, empresa: p.empresa, telefono: p.telefono, activo: p.activo })),
            viajes_recientes_de: principal.nombre,
            viajes_recientes: viajes,
          }),
          ui: {
            tipo: "conductores",
            items: pasajeros.slice(0, 5).map((p) => ({
              nombre: p.nombre,
              estado: p.empresa || (p.activo ? "activo" : "inactivo"),
              telefono: p.telefono,
              alertas: p.dni ? [`DNI ${p.dni}`] : [],
            })),
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_tercerizadas": {
        const meses = Math.min(Math.max(Number(input.meses) || 3, 1), 12);
        const inicio = inicioMeses(meses);

        let qe = sb
          .from("empresas_tercerizadas")
          .select("id, razon_social, ruc, telefono, contacto_nombre, contacto_telefono, venc_autorizacion, estado");
        if (input.nombre) qe = qe.ilike("razon_social", `%${input.nombre}%`);
        const [{ data: emp }, { data: dt }, { data: ct }, { data: vt }, servicios] = await Promise.all([
          qe.limit(40),
          sb.from("documentos_tercero").select("empresa_id, tipo, fecha_vencimiento"),
          sb.from("conductores_tercero").select("empresa_id, vencimiento_licencia"),
          sb.from("vehiculos_tercero").select("empresa_id"),
          fetchPaginado((d, h) =>
            sb
              .from("reservas")
              .select("empresa_tercerizada_id")
              .gte("fecha_servicio", inicio)
              .neq("estado", "cancelada")
              .not("empresa_tercerizada_id", "is", null)
              .range(d, h)
          ),
        ]);
        const empresas = (emp as any[]) ?? [];
        if (empresas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, nota: "Sin empresas tercerizadas con ese filtro." }) };

        const serviciosPorEmpresa: Record<number, number> = {};
        for (const s of servicios) serviciosPorEmpresa[s.empresa_tercerizada_id] = (serviciosPorEmpresa[s.empresa_tercerizada_id] || 0) + 1;
        const unidadesPorEmpresa: Record<number, number> = {};
        for (const v of (vt as any[]) ?? []) unidadesPorEmpresa[v.empresa_id] = (unidadesPorEmpresa[v.empresa_id] || 0) + 1;

        const OBLIG_TERCERO = new Set(tiposObligatorios(true).map((t) => t.canonico));
        const detalle = empresas.map((e) => {
          const docs = ((dt as any[]) ?? []).filter((d) => d.empresa_id === e.id);
          const vencidos: string[] = [];
          const porVencer: string[] = [];
          for (const d of docs) {
            const dias = diasPara(d.fecha_vencimiento);
            if (dias === null) continue;
            const nom = etiquetaTipoDoc(d.tipo);
            // Un documento que no caduca no entra por la fecha: si arrastra una tecleada por
            // error, ELIA reportaría como "vencida" una unidad en regla.
            if (docSinVencimiento(d.tipo)) continue;
            if (dias < 0 && OBLIG_TERCERO.has(nom)) vencidos.push(nom);
            else if (dias >= 0 && dias <= 30 && OBLIG_TERCERO.has(nom)) porVencer.push(`${nom} (${dias}d)`);
          }
          for (const [campo, etiqueta] of [
            ["venc_autorizacion", "Autorización de transporte"],
          ] as [string, string][]) {
            const dias = diasPara(e[campo]);
            if (dias === null) continue;
            if (dias < 0) vencidos.push(etiqueta);
            else if (dias <= 30) porVencer.push(`${etiqueta} (${dias}d)`);
          }
          const licenciasVencidas = ((ct as any[]) ?? []).filter(
            (c) => c.empresa_id === e.id && (diasPara(c.vencimiento_licencia) ?? 1) < 0
          ).length;
          const riesgo = vencidos.length > 0 || licenciasVencidas > 0 ? "ALTO" : porVencer.length > 0 ? "MEDIO" : "OK";
          return {
            empresa: e.razon_social,
            ruc: e.ruc,
            contacto: e.contacto_nombre,
            telefono: e.contacto_telefono || e.telefono,
            estado: e.estado,
            riesgo,
            docs_vencidos: vencidos,
            docs_por_vencer: porVencer,
            licencias_conductores_vencidas: licenciasVencidas,
            unidades: unidadesPorEmpresa[e.id] || 0,
            servicios_periodo: serviciosPorEmpresa[e.id] || 0,
          };
        });
        const enRiesgo = detalle.filter((d) => d.riesgo !== "OK");

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            encontradas: detalle.length,
            en_riesgo: enRiesgo.length,
            empresas: detalle.sort((a, b) => b.servicios_periodo - a.servicios_periodo),
            nota: "Riesgo ALTO = documento obligatorio o licencia de conductor VENCIDO (no deberían operar servicios nuestros hasta regularizar). MEDIO = por vencer en ≤30 días.",
          }),
          ui: [
            {
              tipo: "kpis",
              items: [
                { label: "Empresas", valor: String(detalle.length), intent: "info" },
                { label: "En riesgo", valor: String(enRiesgo.length), intent: enRiesgo.some((d) => d.riesgo === "ALTO") ? "danger" : enRiesgo.length ? "warn" : "ok" },
                { label: "Servicios del período", valor: String(servicios.length), sub: `desde ${inicio}`, intent: "info" },
              ],
            },
            ...(enRiesgo.length
              ? [
                  {
                    tipo: "conductores",
                    items: enRiesgo.slice(0, 6).map((d) => ({
                      nombre: d.empresa,
                      estado: `riesgo ${d.riesgo} · ${d.servicios_periodo} servicios`,
                      telefono: d.telefono,
                      alertas: [
                        ...d.docs_vencidos.map((x: string) => `${x} VENCIDO`),
                        ...d.docs_por_vencer.map((x: string) => `${x} por vencer`),
                        ...(d.licencias_conductores_vencidas ? [`${d.licencias_conductores_vencidas} licencia(s) de conductor vencida(s)`] : []),
                      ],
                    })),
                  } as BloqueUI,
                ]
              : []),
          ],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_personal": {
        let q = sb
          .from("personal_administrativo")
          .select(
            "id, nombre, dni, cargo, departamento, telefono, email, estado, tipo_contrato, fecha_venc_contrato, sctr_salud_venc, sctr_pension_venc, examen_medico_venc, antecedentes_venc, vida_ley, vida_ley_venc"
          )
          .neq("estado", "de_baja");
        if (input.nombre) q = q.ilike("nombre", `%${input.nombre}%`);
        const { data } = await q.order("nombre").limit(60);
        const personal = (data as any[]) ?? [];
        if (personal.length === 0) return { paraModelo: JSON.stringify({ encontrados: 0 }) };

        const DOCS: [string, string][] = [
          ["fecha_venc_contrato", "Contrato"],
          ["sctr_salud_venc", "SCTR Salud"],
          ["sctr_pension_venc", "SCTR Pensión"],
          ["examen_medico_venc", "Examen médico"],
          ["antecedentes_venc", "Antecedentes"],
          ["vida_ley_venc", "Vida Ley"],
        ];
        const items: ConductorUI[] = personal.map((p) => {
          const alertas: string[] = [];
          for (const [campo, etiqueta] of DOCS) {
            if (campo === "fecha_venc_contrato" && p.tipo_contrato !== "plazo_fijo") continue;
            const dias = diasPara(p[campo]);
            if (dias === null) continue;
            if (dias < 0) alertas.push(`${etiqueta} VENCIDO hace ${Math.abs(dias)} día(s)`);
            else if (dias <= 30) alertas.push(`${etiqueta} vence en ${dias} día(s)`);
          }
          return { nombre: p.nombre, estado: [p.cargo, p.departamento].filter(Boolean).join(" · "), telefono: p.telefono, alertas };
        });
        const visibles = input.solo_alertas ? items.filter((i) => i.alertas.length > 0) : items;
        return {
          paraModelo: JSON.stringify({ encontrados: visibles.length, personal: visibles }),
          ui: { tipo: "conductores", items: visibles.slice(0, 10) },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_documentos_empresa": {
        let q = sb
          .from("documentos_empresa")
          .select("id, titulo, categoria, alcance, fecha_emision, fecha_vencimiento, created_at");
        if (input.categoria) q = q.eq("categoria", input.categoria);
        const { data } = await q.order("created_at", { ascending: false }).limit(200);
        const docs = (data as any[]) ?? [];
        if (docs.length === 0) return { paraModelo: JSON.stringify({ encontrados: 0, nota: "Sin documentos con ese filtro." }) };

        const detalle = docs.map((d) => {
          const dias = diasPara(d.fecha_vencimiento);
          return {
            titulo: d.titulo,
            categoria: d.categoria,
            alcance: d.alcance,
            vence: d.fecha_vencimiento,
            situacion: dias === null ? "sin_vencimiento" : dias < 0 ? "vencido" : dias <= 30 ? "por_vencer" : "vigente",
            dias,
          };
        });
        const vencidos = detalle.filter((d) => d.situacion === "vencido");
        const porVencer = detalle.filter((d) => d.situacion === "por_vencer");
        const visibles = input.solo_alertas ? [...vencidos, ...porVencer] : detalle;

        return {
          paraModelo: JSON.stringify({
            encontrados: docs.length,
            vencidos: vencidos.length,
            por_vencer_30d: porVencer.length,
            detalle: visibles.slice(0, 15),
          }),
          ui: {
            tipo: "kpis",
            items: [
              { label: "Documentos", valor: String(docs.length), intent: "info" },
              { label: "Vencidos", valor: String(vencidos.length), intent: vencidos.length ? "danger" : "ok" },
              { label: "Por vencer (30d)", valor: String(porVencer.length), intent: porVencer.length ? "warn" : "ok" },
            ],
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_proveedores": {
        let q = sb
          .from("proveedores")
          .select("id, nombre, ruc, telefono, email, tipo, contacto_nombre, contacto_telefono, estado");
        if (input.busqueda) q = q.ilike("nombre", `%${input.busqueda}%`);
        if (input.tipo) q = q.eq("tipo", input.tipo);
        const { data } = await q.order("nombre").limit(30);
        const provs = (data as any[]) ?? [];
        if (provs.length === 0) return { paraModelo: JSON.stringify({ encontrados: 0, nota: "Sin proveedores con ese filtro." }) };
        return {
          paraModelo: JSON.stringify({ encontrados: provs.length, proveedores: provs }),
          ui: {
            tipo: "conductores",
            items: provs.slice(0, 8).map((p) => ({
              nombre: p.nombre,
              estado: [p.tipo, p.estado].filter(Boolean).join(" · "),
              telefono: p.contacto_telefono || p.telefono,
              alertas: p.contacto_nombre ? [`Contacto: ${p.contacto_nombre}`] : [],
            })),
          },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "uso_de_elia": {
        const mes = fechaLima().slice(0, 7);
        try {
          const [{ data: cfg }, { data: gasto }] = await Promise.all([
            sb.from("elia_config").select("modelo, limite_mensual_usd, activa").eq("id", 1).maybeSingle(),
            sb.from("elia_gasto_mensual").select("total_usd, mensajes").eq("mes", mes).maybeSingle(),
          ]);
          if (!cfg)
            return {
              paraModelo: JSON.stringify({
                nota: "Las tablas de control de gasto aún no existen: hay que ejecutar supabase/elia-config.sql en Supabase. Sugiere ir a Configuración → ELIA, donde están las instrucciones.",
              }),
            };
          const total = Number((gasto as any)?.total_usd || 0);
          const limite = Number((cfg as any).limite_mensual_usd || 0);
          const mensajes = Number((gasto as any)?.mensajes || 0);
          return {
            paraModelo: JSON.stringify({
              mes,
              gasto_usd: Math.round(total * 100) / 100,
              limite_usd: limite || "sin límite",
              pct_usado: limite > 0 ? Math.round((total / limite) * 100) : null,
              respuestas: mensajes,
              costo_promedio_usd: mensajes > 0 ? Math.round((total / mensajes) * 1000) / 1000 : null,
              modelo: (cfg as any).modelo,
              nota: "El detalle y la configuración están en Configuración → ELIA.",
            }),
            ui: {
              tipo: "kpis",
              items: [
                { label: `Gasto ${mes}`, valor: `US$ ${total.toFixed(2)}`, intent: limite > 0 && total >= limite * 0.8 ? "warn" : "info" },
                { label: "Límite", valor: limite > 0 ? `US$ ${limite.toFixed(0)}` : "Sin límite", intent: "info" },
                { label: "Respuestas", valor: String(mensajes) },
                { label: "Modelo", valor: String((cfg as any).modelo).replace("claude-", "") },
              ],
            },
          };
        } catch {
          return { paraModelo: JSON.stringify({ nota: "No pude leer el control de gasto (probablemente falta correr supabase/elia-config.sql)." }) };
        }
      }

      // ────────────────────────────────────────────────────────────────────
      case "abrir_modulo": {
        const texto = String(input.destino || "").toLowerCase();
        const ruta = RUTAS_MODULO.find(
          (r) => r.alias.some((a) => texto.includes(a)) || r.etiqueta.toLowerCase().includes(texto)
        );
        if (!ruta) return { paraModelo: JSON.stringify({ ok: false, nota: `No reconozco la pantalla "${input.destino}". Módulos: ${RUTAS_MODULO.map((r) => r.etiqueta).join(", ")}` }) };
        if (!tienePermiso(ctx, [ruta.modulo]))
          return { paraModelo: JSON.stringify({ ok: false, nota: `El usuario no tiene permiso para ${ruta.etiqueta}; dile con tacto que pida acceso a un administrador.` }) };
        return {
          paraModelo: JSON.stringify({ ok: true, href: ruta.href, etiqueta: ruta.etiqueta, nota: "Botón de acceso mostrado al usuario." }),
          ui: { tipo: "link", href: ruta.href, etiqueta: `Ir a ${ruta.etiqueta}` },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "proponer_accion": {
        const { data: r } = await sb
          .from("reservas")
          .select("id, codigo, origen, destino, fecha_servicio, hora_servicio, estado")
          .eq("id", input.reserva_id)
          .maybeSingle();
        if (!r) return { paraModelo: JSON.stringify({ ok: false, nota: `No existe el servicio ${input.reserva_id}.` }) };

        if (input.tipo === "confirmar_reserva" && !["pendiente", "programada"].includes((r as any).estado))
          return {
            paraModelo: JSON.stringify({ ok: false, nota: `El servicio ${r.id} está en estado "${(r as any).estado}"; solo se confirma desde pendiente o programada.` }),
          };

        const titulo =
          input.tipo === "recordatorio_reserva"
            ? "Enviar recordatorio a los pasajeros"
            : "Confirmar el servicio";
        const detalle = `Servicio #${r.id}${(r as any).codigo ? ` (${(r as any).codigo})` : ""}: ${(r as any).origen ?? "—"} → ${(r as any).destino ?? "—"} · ${(r as any).fecha_servicio ?? ""} ${(r as any).hora_servicio ?? ""}`;
        return {
          paraModelo: JSON.stringify({
            ok: true,
            estado: "esperando_confirmacion",
            nota: "La propuesta se mostró como tarjeta con botón. NO afirmes que ya se ejecutó: dile al usuario que la confirme con el botón.",
          }),
          ui: { tipo: "accion", accion: { tipo: input.tipo, reserva_id: r.id, titulo, detalle } },
        };
      }

      default:
        return { paraModelo: JSON.stringify({ error: `Herramienta desconocida: ${nombre}` }) };
    }
  } catch (e: any) {
    return { paraModelo: JSON.stringify({ error: e?.message ?? "Error consultando datos" }) };
  }
}
