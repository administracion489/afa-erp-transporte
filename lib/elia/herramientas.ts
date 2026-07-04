// ============================================================
// ELIA — Herramientas del motor (SOLO servidor).
// Cada herramienta consulta datos REALES de Supabase con service-role,
// pero solo se expone a Claude si el usuario tiene permiso del módulo.
// Devuelve: JSON para el modelo + (opcional) un bloque visual para el panel.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { etiquetaEstado, etiquetaAdmin } from "@/lib/estados";
import type {
  BloqueUI,
  ServicioUI,
  VehiculoUI,
  ConductorUI,
  KpiUI,
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

const fmtSoles = (n: number) =>
  "S/ " + Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const tienePermiso = (ctx: { permisos: string[]; rol: string }, modulos: string[]) =>
  ctx.rol === "admin" || modulos.some((m) => ctx.permisos.includes(m));

const puedeVerPrecios = (ctx: { permisos: string[]; rol: string }) =>
  tienePermiso(ctx, ["facturacion", "reportes", "cotizaciones", "gastos"]);

// Documentos vehiculares obligatorios (mismo criterio que documentos-vehiculares)
const DOCS_OBLIGATORIOS = new Set([
  "SOAT",
  "Revisión Técnica (CITV)",
  "Tarjeta de Propiedad",
  "Habilitación SUTRAN",
  "Permiso Operación MTC",
  "Tarjeta de Circulación",
]);

// ── Rutas navegables (espejo de menuGrupos en app/layout.tsx) ───────────────
export const RUTAS_MODULO: { href: string; etiqueta: string; modulo: string; alias: string[] }[] = [
  { href: "/dashboard", etiqueta: "Dashboard", modulo: "dashboard", alias: ["dashboard", "panel", "inicio", "resumen"] },
  { href: "/cotizaciones", etiqueta: "Cotizaciones", modulo: "cotizaciones", alias: ["cotizaciones", "cotizacion", "precios"] },
  { href: "/cotizador", etiqueta: "Cotizador", modulo: "cotizaciones", alias: ["cotizador", "costos"] },
  { href: "/tarifario", etiqueta: "Tarifas", modulo: "tarifas", alias: ["tarifas", "tarifario"] },
  { href: "/clientes", etiqueta: "Clientes", modulo: "clientes", alias: ["clientes", "cliente", "base comercial"] },
  { href: "/crm", etiqueta: "Inbox CRM", modulo: "crm", alias: ["crm", "inbox", "conversaciones", "whatsapp"] },
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
  finanzas: ["facturacion", "gastos", "reportes"],
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
  finanzas: "Haciendo números…",
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
      "Estado de la flota propia: disponibilidad, semáforo documentario (SOAT, CITV, SUTRAN, MTC…), kilometraje y próximo mantenimiento. Con solo_alertas=true devuelve únicamente unidades con problemas.",
    input_schema: {
      type: "object",
      properties: {
        placa: { type: "string", description: "Filtrar por placa (parcial)" },
        solo_alertas: { type: "boolean", description: "Solo unidades con documentos vencidos/por vencer o mantenimiento próximo" },
      },
    },
  },
  {
    name: "consultar_conductores",
    description:
      "Conductores propios: disponibilidad y vencimientos (licencia, SCTR, examen médico, psicosométrico, antecedentes, vida ley). Con solo_alertas=true devuelve solo los que tienen documentos vencidos o por vencer.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Filtrar por nombre (parcial)" },
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
    name: "gps_en_vivo",
    description:
      "Unidades transmitiendo GPS en los últimos 30 minutos: quién está en línea, con retraso o sin señal, velocidad y SOS activos. Úsala para '¿dónde están los buses?', '¿está transmitiendo la placa X?'.",
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
        .eq("atendido", false);
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
        if (!DOCS_OBLIGATORIOS.has(d.tipo)) continue;
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

export type ResultadoTool = { paraModelo: string; ui?: BloqueUI };

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
        let q = sb
          .from("vehiculos")
          .select("id, placa, categoria, marca, modelo, estado, estado_operativo, kilometraje_actual, proximo_mantenimiento_km, capacidad_pasajeros");
        if (input.placa) q = q.ilike("placa", `%${input.placa}%`);
        const { data } = await q.order("placa").limit(60);
        const flota = (data as any[]) ?? [];
        if (flota.length === 0) return { paraModelo: JSON.stringify({ encontrados: 0 }) };

        const { data: docs } = await sb
          .from("documentos_vehiculo")
          .select("vehiculo_id, tipo, fecha_vencimiento")
          .in("vehiculo_id", flota.map((v) => v.id));

        const porVehiculo: Record<number, { tipo: string; dias: number }[]> = {};
        for (const d of (docs as any[]) ?? []) {
          const dias = diasPara(d.fecha_vencimiento);
          if (dias === null || dias > 30) continue;
          (porVehiculo[d.vehiculo_id] ||= []).push({ tipo: d.tipo, dias });
        }

        const items: VehiculoUI[] = flota.map((v) => {
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

        const visibles = input.solo_alertas ? items.filter((i) => i.semaforo !== "verde") : items;
        return {
          paraModelo: JSON.stringify({
            encontrados: visibles.length,
            total_flota: flota.length,
            vehiculos: visibles.map((i, idx) => ({ ...i })),
          }),
          ui: { tipo: "vehiculos", items: visibles.slice(0, 10) },
        };
      }

      // ────────────────────────────────────────────────────────────────────
      case "consultar_conductores": {
        let q = sb
          .from("conductores")
          .select(
            "id, nombre, telefono, estado, licencia, categoria_licencia, vencimiento_licencia, sctr_salud_venc, sctr_pension_venc, examen_medico_venc, psicosometrico_venc, antecedentes_venc, vida_ley_venc"
          )
          .neq("estado", "de_baja");
        if (input.nombre) q = q.ilike("nombre", `%${input.nombre}%`);
        const { data } = await q.order("nombre").limit(60);
        const filas = (data as any[]) ?? [];
        if (filas.length === 0) return { paraModelo: JSON.stringify({ encontrados: 0 }) };

        const DOCS: [string, string][] = [
          ["vencimiento_licencia", "Licencia"],
          ["sctr_salud_venc", "SCTR Salud"],
          ["sctr_pension_venc", "SCTR Pensión"],
          ["examen_medico_venc", "Examen médico"],
          ["psicosometrico_venc", "Psicosométrico"],
          ["antecedentes_venc", "Antecedentes"],
          ["vida_ley_venc", "Vida Ley"],
        ];
        const items: ConductorUI[] = filas.map((c) => {
          const alertas: string[] = [];
          for (const [campo, etiqueta] of DOCS) {
            const dias = diasPara(c[campo]);
            if (dias === null) continue;
            if (dias < 0) alertas.push(`${etiqueta} VENCIDO hace ${Math.abs(dias)} día(s)`);
            else if (dias <= 30) alertas.push(`${etiqueta} vence en ${dias} día(s)`);
          }
          return { nombre: c.nombre, estado: c.estado, telefono: c.telefono, alertas };
        });
        const visibles = input.solo_alertas ? items.filter((i) => i.alertas.length > 0) : items;
        return {
          paraModelo: JSON.stringify({ encontrados: visibles.length, conductores: visibles }),
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

        const { count: sos } = await sb.from("alertas_sos").select("id", { count: "exact", head: true }).eq("atendido", false);

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
