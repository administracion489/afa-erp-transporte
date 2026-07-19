// lib/radar/acciones.ts — Acciones por categoría del Radar IA (SOLO servidor).
//
// ejecutarAccion() recibe un mensaje ya clasificado + extraído por lib/radar/motor.ts
// y ejecuta la acción correspondiente contra Supabase:
//   - oportunidad_comercial → radar_oportunidades (+ disponibilidad, tarifario, probabilidad)
//   - combustible           → radar_combustible (+ auto-registro en `combustible` si pasa las validaciones)
//   - mantenimiento         → alerta (+ orden en `mantenimiento` si la acción automática está activa)
//   - operaciones           → actualización de estado de la reserva del día (solo transiciones válidas)
//   - documentacion / incidencias / cobranza → alertas en radar_alertas
//
// Regla de la casa: las acciones con efectos reales solo se ejecutan si la config lo
// permite (radar_config.acciones_automaticas) y la confianza supera el umbral; todo lo
// demás queda como alerta + registro para revisión humana. NUNCA se cancela un servicio
// automáticamente.

import { registrarLectura, type Flota } from "@/lib/odometro";
import type {
  AnomaliaCombustible,
  CategoriaRadar,
  DisponibilidadOportunidad,
  ExtraccionCobranza,
  ExtraccionCombustible,
  ExtraccionDocumentacion,
  ExtraccionIncidencia,
  ExtraccionMantenimiento,
  ExtraccionOdometro,
  ExtraccionOperacion,
  ExtraccionOportunidad,
  RadarConfig,
  ResultadoAccion,
  SeveridadAlerta,
} from "./tipos";

// ── Fechas Perú (UTC-5 fijo, sin DST) — mismo patrón que lib/elia/herramientas.ts ──

export function fechaLima(offsetDias = 0): string {
  const ms = Date.now() - 5 * 3600 * 1000 + offsetDias * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function horaLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(11, 16);
}

const diasPara = (f?: string | null): number | null =>
  f ? Math.ceil((new Date(f + "T00:00:00-05:00").getTime() - Date.now()) / 86400000) : null;

// ── Helpers de normalización ─────────────────────────────────────────────────

const fmtSoles = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Últimos 9 dígitos del teléfono (mismo criterio que tel9() en lib/crm-ia.ts)
const tel9 = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-9);

// Texto sin tildes ni mayúsculas (mismo criterio que norm() en app/cotizaciones/page.tsx)
const norm = (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Placa a solo alfanumérico en MAYÚSCULAS (para comparar contra la flota)
const placaNorm = (s?: string | null) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Placa en formato de presentación AAA-123 (o lo más cercano posible)
function placaFormato(s?: string | null): string | null {
  const p = placaNorm(s);
  if (!p) return null;
  return p.length === 6 ? `${p.slice(0, 3)}-${p.slice(3)}` : p;
}

// Número positivo o null (los extractores devuelven null cuando el dato no está)
function numOpc(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Capacidad de tanque estimada por categoría del vehículo ──────────────────
// Copiado de la constante CAPACIDAD_TANQUE de app/combustible/page.tsx (misma heurística).

const CAPACIDAD_TANQUE: Record<string, Record<string, number>> = {
  BUS:     { diesel: 100, gnv: 150, glp: 80,  gasolina: 80,  urea: 30 },
  MINIBUS: { diesel: 60,  gnv: 80,  glp: 50,  gasolina: 50,  urea: 15 },
  VAN:     { diesel: 20,  gnv: 40,  glp: 25,  gasolina: 20,  urea: 10 },
  AUTO:    { diesel: 12,  gnv: 30,  glp: 15,  gasolina: 12,  urea: 5  },
  DEFAULT: { diesel: 80,  gnv: 100, glp: 60,  gasolina: 60,  urea: 20 },
};

function getCapacidad(categoria: string | null | undefined, tipo: string): number {
  if (!categoria) return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
  const cat = categoria.toUpperCase();
  for (const [k, v] of Object.entries(CAPACIDAD_TANQUE)) {
    if (cat.includes(k)) return v[tipo] || v.diesel || 80;
  }
  return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
}

// Marcas de KIT DE CONVERSIÓN A GLP (se ven en el tablero) — NUNCA son el grifo/estación.
// Si la IA las devuelve como grifo/proveedor, se descartan (trampa "LANDI RENZO" del caso CWQ-400).
const MARCAS_KIT_GLP = [
  "landi renzo", "landirenzo", "brc", "lovato", "tomasetto", "zavoli", "omvl", "ac stag",
  "stag", "prins", "vialle", "gasitaly", "cavagna", "bigas", "snit", "longas", "elpigaz", "aeb",
];
function esMarcaKitGLP(s?: string | null): boolean {
  const t = norm(String(s ?? ""));
  if (!t) return false;
  return MARCAS_KIT_GLP.some((m) => t === m || t.includes(m));
}

/**
 * Capacidad del tanque para (vehículo, tipo). Usa la capacidad EDITABLE por vehículo si el
 * operador la configuró (vehiculos.capacidad_tanque jsonb { diesel, glp, gnv, ... }); si no,
 * cae a la heurística por categoría. Editable resuelve el caso GLP: un kit convertido tiene
 * ~20-30 gal, no los 80 que asumía la heurística de un bus.
 */
function capacidadTanque(veh: VehiculoMatch | null, tipo: string): number {
  const editable = veh?.capacidad_tanque?.[tipo];
  if (editable != null && Number(editable) > 0) return Number(editable);
  return getCapacidad(veh?.categoria, tipo);
}

// ── Helpers compartidos contra la BD ─────────────────────────────────────────

/** Inserta una alerta del Radar y devuelve su id. Lanza si el insert falla. */
export async function crearAlerta(
  sb: any,
  a: {
    mensaje_id?: string | null;
    tipo: string;
    severidad: SeveridadAlerta;
    titulo: string;
    detalle?: string | null;
    href?: string | null;
  }
): Promise<string | null> {
  const { data, error } = await sb
    .from("radar_alertas")
    .insert({
      mensaje_id: a.mensaje_id ?? null,
      tipo: a.tipo,
      severidad: a.severidad,
      titulo: a.titulo,
      detalle: a.detalle ?? null,
      href: a.href ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`radar_alertas: ${error.message}`);
  return (data as any)?.id ?? null;
}

export type VehiculoMatch = {
  id: number;
  placa: string;
  categoria: string | null;
  kilometraje_actual: number | null;
  /** Capacidad de tanque editable por tipo de combustible (jsonb en `vehiculos`). null si no configurada. */
  capacidad_tanque?: Record<string, number> | null;
};

/** Empareja una placa (en cualquier formato) contra la flota propia. */
export async function matchVehiculo(sb: any, placa: string | null | undefined): Promise<VehiculoMatch | null> {
  const objetivo = placaNorm(placa);
  if (!objetivo) return null;
  // select("*") en vez de nombrar capacidad_tanque: migration-safe (si el código se despliega
  // antes de correr la migración, la columna simplemente no viene y capacidad_tanque = null).
  const { data } = await sb.from("vehiculos").select("*");
  const hit = ((data as any[]) ?? []).find((v) => placaNorm(v.placa) === objetivo);
  if (!hit) return null;
  return {
    id: hit.id,
    placa: hit.placa,
    categoria: hit.categoria ?? null,
    kilometraje_actual: hit.kilometraje_actual != null ? Number(hit.kilometraje_actual) : null,
    capacidad_tanque: hit.capacidad_tanque ?? null,
  };
}

/**
 * Empareja una placa contra la flota TERCERIZADA (`vehiculos_tercero`). Devuelve `id` y
 * `kilometraje_actual` porque el ODÓMETRO sí se lleva de terceros (lecturas_odometro.
 * vehiculo_tercero_id, ver lib/odometro.ts flota:"tercero"). El COMBUSTIBLE de terceros en
 * cambio NUNCA se auto-registra en `combustible` (esa tabla es el gasto propio de AFA);
 * ahí este match es solo informativo (dar el motivo "es una unidad tercerizada").
 */
async function matchVehiculoTercero(
  sb: any,
  placa: string | null | undefined,
): Promise<{ id: number; placa: string; marca: string | null; modelo: string | null; kilometraje_actual: number | null } | null> {
  const objetivo = placaNorm(placa);
  if (!objetivo) return null;
  try {
    const { data } = await sb.from("vehiculos_tercero").select("id, placa, marca, modelo, kilometraje_actual");
    const hit = ((data as any[]) ?? []).find((v) => placaNorm(v.placa) === objetivo);
    if (!hit) return null;
    return {
      id: hit.id,
      placa: hit.placa,
      marca: hit.marca ?? null,
      modelo: hit.modelo ?? null,
      kilometraje_actual: hit.kilometraje_actual != null ? Number(hit.kilometraje_actual) : null,
    };
  } catch {
    return null;
  }
}

/** Empareja contra `clientes` por teléfono (últimos 9 dígitos), empresa o nombre. */
export async function matchCliente(
  sb: any,
  ref: { telefono?: string | null; empresa?: string | null; cliente?: string | null }
): Promise<number | null> {
  try {
    const tel = tel9(ref.telefono);
    if (tel.length === 9) {
      const { data } = await sb.from("clientes").select("id, telefono").not("telefono", "is", null);
      const hit = ((data as any[]) ?? []).find((c) => tel9(c.telefono) === tel);
      if (hit) return Number(hit.id);
    }
    if (ref.empresa && ref.empresa.trim()) {
      const { data } = await sb.from("clientes").select("id").ilike("empresa", `%${ref.empresa.trim()}%`).limit(1);
      if (data && (data as any[]).length) return Number((data as any[])[0].id);
    }
    if (ref.cliente && ref.cliente.trim()) {
      const { data } = await sb.from("clientes").select("id").ilike("nombre", `%${ref.cliente.trim()}%`).limit(1);
      if (data && (data as any[]).length) return Number((data as any[])[0].id);
    }
  } catch {
    // sin match: la oportunidad se registra igual, solo sin cliente_id
  }
  return null;
}

type OportunidadDuplicada = { id: string; veces_detectada: number; grupos_json: unknown };

/**
 * Busca una oportunidad abierta (nueva/revisada) de las últimas 72h con el MISMO
 * remitente (mismo WhatsApp), la misma ruta normalizada y la misma fecha pedida —
 * el patrón típico de un transportista reenviando/reposteando el mismo pedido en
 * varios grupos que el Radar monitorea.
 */
async function buscarOportunidadDuplicada(
  sb: any,
  ref: { mensaje: any; origen: string; destino: string; fecha: string | null }
): Promise<OportunidadDuplicada | null> {
  try {
    const desde72h = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const { data } = await sb
      .from("radar_oportunidades")
      .select("id, origen, destino, fecha_servicio, veces_detectada, grupos_json, radar_mensajes(remitente_wa)")
      .in("estado", ["nueva", "revisada"])
      .gte("created_at", desde72h);
    const filas = (data as any[]) ?? [];
    const origenNorm = norm(ref.origen);
    const destinoNorm = norm(ref.destino);
    const hit = filas.find((o) => {
      const rel = Array.isArray(o.radar_mensajes) ? o.radar_mensajes[0] : o.radar_mensajes;
      const mismoRemitente = !!rel?.remitente_wa && rel.remitente_wa === ref.mensaje.remitente_wa;
      const mismaRuta = norm(String(o.origen ?? "")) === origenNorm && norm(String(o.destino ?? "")) === destinoNorm;
      const mismaFecha = (o.fecha_servicio ?? null) === ref.fecha;
      return mismoRemitente && mismaRuta && mismaFecha;
    });
    if (!hit) return null;
    return { id: hit.id, veces_detectada: Number(hit.veces_detectada || 1), grupos_json: hit.grupos_json };
  } catch {
    // sin poder verificar duplicado: se registra como nueva oportunidad (mejor un duplicado que perder el lead)
    return null;
  }
}

// ── Punto de entrada ─────────────────────────────────────────────────────────

type ArgsAccion = {
  sb: any;
  mensaje: any; // fila de radar_mensajes
  categoria: CategoriaRadar;
  datos: any; // extracción de la IA (forma según categoría)
  confianza: number;
  config: RadarConfig;
};

export async function ejecutarAccion(args: ArgsAccion): Promise<ResultadoAccion> {
  try {
    switch (args.categoria) {
      case "oportunidad_comercial": return await accionOportunidad(args);
      case "combustible":           return await accionCombustible(args);
      case "odometro":              return await accionOdometro(args);
      case "mantenimiento":         return await accionMantenimiento(args);
      case "operaciones":           return await accionOperaciones(args);
      case "documentacion":         return await accionDocumentacion(args);
      case "incidencias":           return await accionIncidencia(args);
      case "cobranza":              return await accionCobranza(args);
      default:
        return { accion: "sin_accion", detalle: "Categoría sin acción asociada" };
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return {
      accion: "error_accion",
      detalle: `No se pudo ejecutar la acción de ${args.categoria}: ${msg}`,
      datos: { error: msg },
    };
  }
}

// Firma "Radar IA · grupo · remitente" para observaciones de los registros creados.
function firmaRadar(mensaje: any): string {
  return ["Radar IA", mensaje?.grupo_nombre, mensaje?.remitente_nombre ?? mensaje?.remitente_wa]
    .filter(Boolean)
    .join(" · ");
}

// ── Oportunidad comercial ────────────────────────────────────────────────────

async function accionOportunidad({ sb, mensaje, datos }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionOportunidad;
  const hoy = fechaLima();
  const manana = fechaLima(1);
  const fechaRef = d.fecha || hoy; // sin fecha pedida, la disponibilidad se calcula para hoy
  const tipo = d.tipo_vehiculo ? String(d.tipo_vehiculo).toUpperCase() : null;
  const entradaGrupo = { grupo_nombre: mensaje.grupo_nombre ?? null, mensaje_id: mensaje.id, recibido_en: new Date().toISOString() };

  // 0) Deduplicar: transportistas terceros suelen reenviar/repostear el MISMO pedido a
  //    varios grupos que el Radar monitorea. Si el mismo remitente (mismo WhatsApp) ya
  //    pidió la misma ruta para la misma fecha en las últimas 72h, fusiona en esa fila
  //    en vez de crear una tarjeta nueva.
  if (d.origen && d.destino && mensaje.remitente_wa) {
    const duplicada = await buscarOportunidadDuplicada(sb, { mensaje, origen: d.origen, destino: d.destino, fecha: d.fecha ?? null });
    if (duplicada) {
      const nuevoConteo = Number(duplicada.veces_detectada || 1) + 1;
      const grupos = Array.isArray(duplicada.grupos_json) ? duplicada.grupos_json : [];
      const { error: errUpd } = await sb
        .from("radar_oportunidades")
        .update({ veces_detectada: nuevoConteo, grupos_json: [...grupos, entradaGrupo] })
        .eq("id", duplicada.id);
      if (errUpd) throw new Error(`radar_oportunidades (dedupe): ${errUpd.message}`);
      return {
        accion: "oportunidad_duplicada",
        detalle: `Mismo pedido ya registrado — visto en ${nuevoConteo} grupo(s)/mensaje(s), no se creó una tarjeta nueva`,
        datos: { oportunidad_id: duplicada.id, veces_detectada: nuevoConteo },
      };
    }
  }

  // 1) Recursos ya asignados ese día (excluye canceladas)
  const { data: resDia } = await sb
    .from("reservas")
    .select("vehiculo_id, conductor_id")
    .eq("fecha_servicio", fechaRef)
    .neq("estado", "cancelada");
  const reservasDia = (resDia as any[]) ?? [];
  const vehAsignados = new Set(reservasDia.map((r) => r.vehiculo_id).filter(Boolean));
  const condAsignados = new Set(reservasDia.map((r) => r.conductor_id).filter(Boolean));

  // 2) Vehículos disponibles menos los asignados
  const { data: vehs } = await sb.from("vehiculos").select("id, categoria").eq("estado", "disponible");
  const libres = ((vehs as any[]) ?? []).filter((v) => !vehAsignados.has(v.id));
  const libresTipo = tipo ? libres.filter((v) => String(v.categoria ?? "").toUpperCase() === tipo) : null;

  // 3) Conductores operativos con licencia vigente menos los asignados
  const { data: conds } = await sb
    .from("conductores")
    .select("id, vencimiento_licencia")
    .neq("estado", "no_disponible");
  const condsLibres = ((conds as any[]) ?? []).filter(
    (c) => (!c.vencimiento_licencia || c.vencimiento_licencia >= hoy) && !condAsignados.has(c.id)
  );

  const disponibilidad: DisponibilidadOportunidad = {
    vehiculos_libres: libres.length,
    vehiculos_tipo: libresTipo ? libresTipo.length : null,
    conductores_libres: condsLibres.length,
    servicios_ese_dia: reservasDia.length,
    detalle: `${libres.length} vehículo(s) libre(s)${tipo ? ` (${libresTipo!.length} ${tipo})` : ""}, ${condsLibres.length} conductor(es) libre(s), ${reservasDia.length} servicio(s) el ${fechaRef}`,
  };

  // 4) Tarifario: match por origen/destino normalizados (norm() del cotizador)
  let precioRef: number | null = null;
  if (d.origen && d.destino) {
    const { data: tarifas } = await sb
      .from("tarifario")
      .select("origen, destino, tipo_vehiculo, precio")
      .eq("activo", true);
    const matches = ((tarifas as any[]) ?? []).filter(
      (t) => norm(String(t.origen ?? "")) === norm(d.origen!) && norm(String(t.destino ?? "")) === norm(d.destino!)
    );
    const conTipo = tipo ? matches.find((t) => String(t.tipo_vehiculo ?? "").toUpperCase() === tipo) : null;
    const elegida = conTipo ?? matches[0] ?? null;
    if (elegida && Number(elegida.precio) > 0) precioRef = Number(elegida.precio);
  }
  // Margen típico del cotizador: 25% del precio (sin IGV)
  const utilidad = precioRef != null ? Math.round(precioRef * 0.25 * 100) / 100 : null;

  // 5) Cliente conocido
  const clienteId = await matchCliente(sb, { telefono: d.telefono, empresa: d.empresa, cliente: d.cliente });

  // 6) Probabilidad estimada (heurística acotada a 95)
  let probabilidad = 20;
  if (clienteId) probabilidad += 25;
  if (precioRef != null) probabilidad += 20;
  if (tipo ? (libresTipo?.length ?? 0) > 0 : libres.length > 0) probabilidad += 25;
  if (d.fecha && d.origen && d.destino) probabilidad += 10;
  probabilidad = Math.min(95, probabilidad);

  // 7) Registro de la oportunidad
  const { data: op, error } = await sb
    .from("radar_oportunidades")
    .insert({
      mensaje_id: mensaje.id,
      estado: "nueva",
      fecha_servicio: d.fecha ?? null,
      hora_servicio: d.hora ?? null,
      ciudad: d.ciudad ?? null,
      distrito: d.distrito ?? null,
      origen: d.origen ?? null,
      destino: d.destino ?? null,
      pasajeros: numOpc(d.pasajeros),
      tipo_vehiculo: tipo,
      unidades: numOpc(d.unidades),
      tiempo_espera: d.tiempo_espera ?? null,
      servicios_adicionales: d.servicios_adicionales ?? null,
      cliente_nombre: d.cliente ?? null,
      empresa: d.empresa ?? null,
      telefono: d.telefono ?? null,
      observaciones: d.observaciones ?? null,
      cliente_id: clienteId,
      disponibilidad,
      precio_referencial: precioRef,
      utilidad_estimada: utilidad,
      probabilidad,
      grupos_json: [entradaGrupo],
    })
    .select("id")
    .single();
  if (error) throw new Error(`radar_oportunidades: ${error.message}`);

  // 8) Alerta: crítica si el servicio es para hoy o mañana (Lima)
  const urgente = !!d.fecha && (d.fecha === hoy || d.fecha === manana);
  const severidad: SeveridadAlerta = urgente ? "critico" : "atencion";
  const titulo = `💼 Oportunidad: ${d.pasajeros ? `${d.pasajeros} pax ` : ""}${d.origen ?? "¿origen?"} → ${d.destino ?? "¿destino?"}${d.fecha ? ` ${d.fecha}` : ""}`;
  const detalleAlerta = [
    precioRef != null ? `Tarifa referencial ${fmtSoles(precioRef)}` : "Sin tarifa en el tarifario",
    disponibilidad.detalle,
    `Probabilidad estimada ${probabilidad}%`,
  ].join(" · ");
  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "oportunidad",
    severidad,
    titulo,
    detalle: detalleAlerta,
    href: "/radar-ia?tab=oportunidades",
  });

  return {
    accion: "oportunidad_creada",
    detalle: `Oportunidad registrada (${probabilidad}% de probabilidad)${precioRef != null ? ` con tarifa referencial ${fmtSoles(precioRef)}` : ""}`,
    datos: {
      oportunidad_id: (op as any)?.id ?? null,
      alerta_id: alertaId,
      severidad,
      titulo,
      probabilidad,
      precio_referencial: precioRef,
      utilidad_estimada: utilidad,
      cliente_id: clienteId,
      disponibilidad,
    },
  };
}

// ── Combustible ──────────────────────────────────────────────────────────────

async function accionCombustible({ sb, mensaje, datos, confianza, config }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionCombustible;
  const fecha = d.fecha || fechaLima();
  const placa = placaFormato(d.placa);
  const veh = await matchVehiculo(sb, d.placa);
  const tipoComb = String(d.tipo_combustible || "diesel").toLowerCase();
  const cantidad = numOpc(d.galones) ?? numOpc(d.litros);
  const precioUnit = numOpc(d.precio_galon) ?? numOpc(d.precio_litro);
  const monto = numOpc(d.monto_total);
  const km = numOpc(d.kilometraje);
  const umbral = Number(config.umbral_confianza ?? 0.7);

  const anomalias: AnomaliaCombustible[] = [];

  // ── Campos del camino de VISIÓN multi-foto (opcionales; el de texto no los llena) ──
  const consumoTasa = numOpc(d.consumo_l_100km);
  const tripKm = numOpc(d.trip_km);
  const vioNota = d.vio_nota === true;
  const vioSurtidor = d.vio_surtidor === true;
  const discrepancias = Array.isArray(d.discrepancias) ? d.discrepancias.filter(Boolean) : [];

  // Identidad: el grifo/proveedor JAMÁS es una marca de kit GLP del tablero (trampa "LANDI RENZO").
  let grifo = d.grifo ?? null;
  let proveedor = d.proveedor ?? null;
  if (esMarcaKitGLP(grifo) || esMarcaKitGLP(proveedor)) {
    anomalias.push({
      codigo: "marca_kit_como_grifo",
      detalle: `"${grifo ?? proveedor}" es la marca del kit de conversión a GLP del tablero, no un grifo — se ignoró como estación`,
      bloquea: true,
    });
    if (esMarcaKitGLP(grifo)) grifo = null;
    if (esMarcaKitGLP(proveedor)) proveedor = null;
  }

  // Guard determinista (no confiar solo en el prompt): "16.3 L/100km" es una TASA de consumo,
  // no una cantidad cargada. 16.3 es un galonaje plausible → sin este freno pasaría todos los
  // controles y registraría una carga fantasma.
  if (cantidad != null && consumoTasa != null && Math.abs(cantidad - consumoTasa) < 0.1) {
    anomalias.push({
      codigo: "tasa_como_cantidad",
      detalle: `La cantidad (${cantidad}) coincide con la tasa de consumo (${consumoTasa} L/100km) — probable confusión: una tasa se registró como galones`,
      bloquea: true,
    });
  }
  // Guard: el "Trip"/viaje parcial del tablero no es el odómetro total.
  if (km != null && tripKm != null && km === tripKm) {
    anomalias.push({
      codigo: "trip_como_odometro",
      detalle: `El kilometraje (${km.toLocaleString("es-PE")}) coincide con el "Trip"/viaje parcial — probable confusión con el odómetro total`,
      bloquea: true,
    });
  }
  // Discrepancias surtidor/display vs nota que reportó la IA: la NOTA manda (decisión del
  // operador); el valor del surtidor queda solo como alerta informativa (no bloquea).
  for (const disc of discrepancias) {
    anomalias.push({ codigo: "discrepancia_maquina_vs_nota", detalle: String(disc).slice(0, 240), bloquea: false });
  }

  // 1) Cantidad vs capacidad del tanque (editable por vehículo si el operador la configuró)
  if (veh && cantidad != null) {
    const cap = capacidadTanque(veh, tipoComb);
    if (cantidad > cap * 1.1) {
      anomalias.push({
        codigo: "galones_exceden_tanque",
        detalle: `Cantidad ${cantidad} supera la capacidad estimada del tanque de ${tipoComb} (${cap})`,
      });
    }
  }

  // 2) Posible duplicado: misma unidad, mismo día, monto casi idéntico
  if (monto != null) {
    if (veh) {
      const { data: mismos } = await sb
        .from("combustible")
        .select("id, total")
        .eq("vehiculo_id", veh.id)
        .eq("fecha", fecha);
      const dup = ((mismos as any[]) ?? []).find((r) => Math.abs(Number(r.total || 0) - monto) < 1);
      if (dup) {
        anomalias.push({
          codigo: "posible_duplicado",
          detalle: `Ya existe una carga del ${fecha} por ${fmtSoles(Number(dup.total || 0))} (registro #${dup.id})`,
        });
      }
    }
    if (placa && !anomalias.some((a) => a.codigo === "posible_duplicado")) {
      const { data: rc } = await sb
        .from("radar_combustible")
        .select("id, monto_total")
        .eq("placa", placa)
        .eq("fecha", fecha)
        .in("estado", ["registrado", "pendiente_revision"]);
      const dup = ((rc as any[]) ?? []).find(
        (r) => r.monto_total != null && Math.abs(Number(r.monto_total) - monto) < 1
      );
      if (dup) {
        anomalias.push({
          codigo: "posible_duplicado",
          detalle: `El Radar ya capturó una carga de ${placa} el ${fecha} por un monto similar`,
        });
      }
    }
  }

  // 3) Precio unitario vs referencia de precios_combustible (±20%)
  if (precioUnit != null) {
    try {
      const { data: precios } = await sb.from("precios_combustible").select("tipo, precio");
      const ref = ((precios as any[]) ?? []).find((p) => String(p.tipo ?? "").toLowerCase() === tipoComb);
      const pRef = ref ? Number(ref.precio) : 0;
      if (pRef > 0 && Math.abs(precioUnit - pRef) / pRef > 0.2) {
        anomalias.push({
          codigo: "precio_fuera_de_rango",
          detalle: `Precio ${fmtSoles(precioUnit)} se aleja más de 20% del referencial ${fmtSoles(pRef)} (${tipoComb})`,
        });
      }
    } catch {
      // sin tabla de precios: se omite este chequeo
    }
  }

  // 4) Kilometraje menor al vigente del vehículo
  if (veh && km != null && Number(veh.kilometraje_actual || 0) > 0 && km < Number(veh.kilometraje_actual)) {
    anomalias.push({
      codigo: "km_menor_al_actual",
      detalle: `Kilometraje ${km.toLocaleString("es-PE")} menor al vigente ${Number(veh.kilometraje_actual).toLocaleString("es-PE")}`,
    });
  }

  // 5) Consumo excesivo: rendimiento del tramo >30% bajo el promedio del vehículo
  if (veh && km != null && cantidad != null) {
    const { data: prevs } = await sb
      .from("combustible")
      .select("kilometraje, galones")
      .eq("vehiculo_id", veh.id)
      .eq("tipo_combustible", tipoComb)
      .gt("kilometraje", 0)
      .order("kilometraje", { ascending: true });
    const regs = (prevs as any[]) ?? [];
    const rends: number[] = [];
    for (let i = 1; i < regs.length; i++) {
      const dkm = Number(regs[i].kilometraje) - Number(regs[i - 1].kilometraje);
      const qty = Number(regs[i].galones);
      if (dkm > 0 && qty > 0) rends.push(dkm / qty);
    }
    const promedio = rends.length ? rends.reduce((a, b) => a + b) / rends.length : null;
    const previa = [...regs].reverse().find((r) => Number(r.kilometraje) < km);
    if (promedio && previa) {
      const rend = (km - Number(previa.kilometraje)) / cantidad;
      if (rend > 0 && (promedio - rend) / promedio > 0.3) {
        anomalias.push({
          codigo: "consumo_excesivo",
          detalle: `Rendimiento del tramo ${rend.toFixed(1)} vs promedio ${promedio.toFixed(1)} (más de 30% por debajo)`,
        });
      }
    }
  }

  // 6) Recarga de madrugada (00:00–04:59)
  const hMatch = /^(\d{1,2}):\d{2}/.exec(String(d.hora ?? ""));
  if (hMatch) {
    const h = Number(hMatch[1]);
    if (h >= 0 && h <= 4) {
      anomalias.push({ codigo: "recarga_madrugada", detalle: `Recarga a las ${d.hora} (madrugada)` });
    }
  }

  // 7) Cantidad × precio no cuadra con el total del voucher
  if (cantidad != null && precioUnit != null && monto != null) {
    const calc = cantidad * precioUnit;
    if (Math.abs(calc - monto) > Math.max(2, 0.05 * monto)) {
      anomalias.push({
        codigo: "monto_inconsistente",
        detalle: `Cantidad × precio = ${fmtSoles(calc)} pero el total reportado es ${fmtSoles(monto)}`,
      });
    }
  }

  // 8) La cantidad tiene EXACTAMENTE los mismos dígitos que el kilometraje → casi siempre
  //    la IA copió la lectura del odómetro en el campo de galones (mismo número, solo cambia
  //    el punto decimal: p.ej. galones "8.173" vs kilometraje "8173"). Un galonaje real y un
  //    odómetro no comparten dígitos por azar; cuando coinciden, es confusión de campos. Se
  //    manda a revisión aunque cantidad × precio "cuadre" con el total (ese chequeo puede
  //    pasar por casualidad cuando galones y precio están mal a la vez).
  if (cantidad != null && km != null) {
    const soloDigitos = (n: number) => String(n).replace(/[^0-9]/g, "");
    const dc = soloDigitos(cantidad);
    if (dc.length >= 3 && dc === soloDigitos(km)) {
      anomalias.push({
        codigo: "galones_coinciden_km",
        detalle: `La cantidad (${cantidad}) tiene los mismos dígitos que el kilometraje (${km.toLocaleString("es-PE")}) — probable confusión: la lectura del odómetro se registró como galones`,
      });
    }
  }

  // ¿"Faltan datos" DE VERDAD o el voucher estaba pero no se leyó? Si vino foto de nota/surtidor
  // pero no se pudo sacar la cantidad o el importe, es lectura fallida (no dato ausente) → bloquea
  // el auto-registro y le dice al revisor "revisa la foto del voucher" en vez de "faltan datos".
  const faltaCantidadOMonto = cantidad == null || (monto == null && precioUnit == null);
  if (faltaCantidadOMonto && (vioNota || vioSurtidor)) {
    anomalias.push({
      codigo: "voucher_no_leido",
      detalle: "Hay una foto de la nota/surtidor pero no se pudo leer la cantidad o el importe — revisar la foto del voucher",
      bloquea: true,
    });
  }

  // Fila base para radar_combustible (se inserta SIEMPRE, con el estado que corresponda)
  const filaRadar: Record<string, unknown> = {
    mensaje_id: mensaje.id,
    placa,
    vehiculo_id: veh?.id ?? null,
    fecha,
    hora: d.hora ?? null,
    grifo,
    direccion_grifo: d.direccion_grifo ?? null,
    tipo_combustible: d.tipo_combustible ?? null,
    galones: numOpc(d.galones),
    litros: numOpc(d.litros),
    precio_galon: numOpc(d.precio_galon),
    precio_litro: numOpc(d.precio_litro),
    monto_total: monto,
    comprobante: d.comprobante ?? null,
    kilometraje: km,
    conductor: d.conductor ?? null,
    proveedor,
    anomalias,
  };

  // ¿Se puede registrar automáticamente en la tabla real `combustible`?
  // El gate distingue anomalías BLOQUEANTES de observaciones (bloquea:false), así una discrepancia
  // informativa surtidor↔nota no frena una carga por lo demás correcta. La boleta única y clara
  // (una sola foto legible, sin observaciones) sigue auto-registrándose como antes.
  const sinBloqueantes = !anomalias.some((a) => a.bloquea !== false);
  const puedeAuto =
    config.acciones_automaticas?.combustible === true &&
    !!veh &&
    cantidad != null &&
    (monto != null || precioUnit != null) &&
    confianza >= umbral &&
    sinBloqueantes;

  if (puedeAuto) {
    // Payload espejo del guardado de app/combustible/page.tsx (NUNCA escribir `total`: columna generada)
    const precioFinal =
      precioUnit ?? (monto != null && cantidad ? Math.round((monto / cantidad) * 100) / 100 : 0);
    const observaciones =
      firmaRadar(mensaje) +
      (d.comprobante ? ` · Comprobante ${d.comprobante}` : "") +
      (d.direccion_grifo ? ` · ${d.direccion_grifo}` : "");

    const { data: comb, error: errComb } = await sb
      .from("combustible")
      .insert({
        vehiculo_id: veh!.id,
        fecha,
        kilometraje: km ?? 0,
        galones: cantidad,
        precio_galon: precioFinal,
        grifo,
        conductor: d.conductor ?? null,
        observaciones,
        tipo_combustible: d.tipo_combustible ?? "diesel",
        unidad: numOpc(d.galones) != null ? "galones" : "litros",
      })
      .select("id")
      .single();
    if (errComb) throw new Error(`combustible: ${errComb.message}`);
    const combustibleId = Number((comb as any)?.id);

    // Alimentar el odómetro consolidado (anti-retroceso). fuente="combustible" deja marcado que
    // esta lectura se tomó EN LA RECARGA (base para el rendimiento km/galón y la auditoría de km).
    if (km != null && km > 0) {
      await registrarLectura(sb, {
        vehiculo_id: veh!.id,
        km,
        fuente: "combustible",
        fecha,
        foto_url: mensaje.media_url ?? null,
        ref_origen: "radar_ia",
      });
    }

    const { error: errRadar } = await sb
      .from("radar_combustible")
      .insert({ ...filaRadar, estado: "registrado", combustible_id: combustibleId });
    if (errRadar) throw new Error(`radar_combustible: ${errRadar.message}`);

    return {
      accion: "combustible_registrado",
      detalle: `Carga de ${veh!.placa} registrada en /combustible: ${cantidad} ${numOpc(d.galones) != null ? "gal" : "lt"} de ${tipoComb}${monto != null ? ` por ${fmtSoles(monto)}` : ""}`,
      datos: { combustible_id: combustibleId, vehiculo_id: veh!.id, anomalias },
    };
  }

  // Queda en revisión: registrar + alertar con los motivos
  const { data: rcIns, error: errRadar } = await sb
    .from("radar_combustible")
    .insert({ ...filaRadar, estado: "pendiente_revision", combustible_id: null })
    .select("id")
    .single();
  if (errRadar) throw new Error(`radar_combustible: ${errRadar.message}`);

  const motivos: string[] = anomalias.map((a) => a.detalle);
  if (config.acciones_automaticas?.combustible !== true) motivos.push("Registro automático de combustible desactivado en la configuración");
  if (!veh) {
    const tercero = placa ? await matchVehiculoTercero(sb, placa) : null;
    if (tercero) {
      motivos.push(`${tercero.placa} es una unidad TERCERIZADA (${[tercero.marca, tercero.modelo].filter(Boolean).join(" ") || "sin marca/modelo"}) — no se registra automático, revisar manualmente si corresponde`);
    } else {
      motivos.push(placa ? `Placa ${placa} no está registrada en la flota propia ni en tercerizadas` : "Mensaje sin placa identificable");
    }
  }
  if (cantidad == null)
    motivos.push(vioSurtidor || vioNota
      ? "No se pudo leer la cantidad de la foto del surtidor/voucher — revisar la foto"
      : "Sin cantidad (galones/litros): falta la foto del surtidor o del voucher");
  if (monto == null && precioUnit == null)
    motivos.push(vioNota
      ? "No se pudo leer el importe de la nota — revisar la foto"
      : "Sin monto total ni precio unitario: falta la foto del voucher");
  if (confianza < umbral) motivos.push(`Confianza ${Math.round(confianza * 100)}% por debajo del umbral ${Math.round(umbral * 100)}%`);

  const severidad: SeveridadAlerta = anomalias.some(
    (a) =>
      a.codigo === "posible_duplicado" ||
      a.codigo === "galones_exceden_tanque" ||
      a.codigo === "galones_coinciden_km" ||
      a.codigo === "marca_kit_como_grifo" ||
      a.codigo === "tasa_como_cantidad" ||
      a.codigo === "trip_como_odometro" ||
      a.codigo === "voucher_no_leido"
  )
    ? "critico"
    : "atencion";
  const titulo = `⛽ Combustible por revisar: ${veh?.placa ?? placa ?? d.unidad ?? "unidad sin identificar"}${monto != null ? ` · ${fmtSoles(monto)}` : ""}`;
  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "combustible_anomalia",
    severidad,
    titulo,
    detalle: motivos.join(" · ") || "Requiere revisión manual",
    href: "/radar-ia?tab=combustible",
  });

  return {
    accion: "combustible_en_revision",
    detalle: `Carga capturada pero quedó en revisión: ${motivos[0] ?? "requiere revisión manual"}`,
    datos: {
      radar_combustible_id: (rcIns as any)?.id ?? null,
      alerta_id: alertaId,
      severidad,
      titulo,
      anomalias,
      motivos,
    },
  };
}

// ── Odómetro (solo lectura de kilometraje, sin datos de recarga) ────────────
//
// A diferencia de combustible, aquí NO hay monto/anomalías que calcular: lib/odometro.ts
// (registrarLectura) ya trae su propia protección anti-retroceso/anti-salto — una lectura
// rara queda "sospechosa" (nunca corrompe el km vigente) y se revisa en el panel de
// odómetro, que ya tiene el flujo de aceptar/rechazar.
//
// El odómetro SÍ se lleva de ambas flotas: matchea la placa contra la propia (`vehiculos`,
// FK vehiculo_id, panel /mantenimiento) y, si no está, contra la tercerizada
// (`vehiculos_tercero`, FK vehiculo_tercero_id, panel /tercerizadas). registrarLectura()
// enruta a la tabla/FK correcta con `flota` — ver targetFlota() en lib/odometro.ts.

/** Unidad resuelta para una lectura de odómetro, independientemente de su flota. */
type UnidadOdometro = { id: number; placa: string; kilometraje_actual: number | null; flota: Flota };

/** Resuelve la placa a una unidad de la flota PROPIA o, si no está, de la TERCERIZADA. */
async function resolverUnidadOdometro(sb: any, placa: string | null | undefined): Promise<UnidadOdometro | null> {
  const propia = await matchVehiculo(sb, placa);
  if (propia) return { id: propia.id, placa: propia.placa, kilometraje_actual: propia.kilometraje_actual, flota: "propia" };
  const tercero = await matchVehiculoTercero(sb, placa);
  if (tercero) return { id: tercero.id, placa: tercero.placa, kilometraje_actual: tercero.kilometraje_actual, flota: "tercero" };
  return null;
}
// Señales fuertes de que el mensaje describía una COMPRA de combustible (no solo el km).
// Si un mensaje así termina clasificado como "odometro", probablemente la IA no pudo leer
// el voucher (foto borrosa) y el gasto se perdería en silencio — mejor avisar.
const SENALES_COMPRA = /voucher|v[au]cher|comprobante|factura|boleta|importe|\bmonto\b|soles|s\/\s*\d|\bgrifo\b|gal[oó]n|precio/i;

async function accionOdometro({ sb, mensaje, datos, confianza, config }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionOdometro;
  const unidad = await resolverUnidadOdometro(sb, d.placa);
  const km = numOpc(d.kilometraje);
  const umbral = Number(config.umbral_confianza ?? 0.7);
  const puedeAuto = config.acciones_automaticas?.odometro === true && !!unidad && km != null && confianza >= umbral;

  // Guardarraíl de la promesa "una lectura rara nunca corrompe el km vigente sin que nadie
  // la vea": si la unidad aún no tiene kilometraje vigente, esta lectura es la PRIMERA y
  // registrarLectura la acepta sin comparación posible (no hay base contra qué validarla).
  const esPrimeraLectura = !unidad || !(Number(unidad.kilometraje_actual ?? 0) > 0);
  // ¿El mensaje sonaba a una compra de combustible? (posible voucher mal leído → clasificado odómetro)
  const sospechaVoucher = SENALES_COMPRA.test(String(mensaje.texto ?? ""));
  // Dónde revisa el humano según la flota: propia en /mantenimiento, tercero en /tercerizadas.
  const esTercero = unidad?.flota === "tercero";
  const dondeRevisar = esTercero ? "/tercerizadas (ficha de la unidad → Odómetro)" : "/mantenimiento (pestaña Odómetro)";
  const hrefOdometro = esTercero ? "/tercerizadas" : "/mantenimiento?tab=odometro";
  const etiquetaFlota = esTercero ? " (tercerizada)" : "";

  let errorRegistro: string | null = null;

  if (puedeAuto) {
    const res = await registrarLectura(sb, {
      vehiculo_id: unidad!.id,
      km: km!,
      fuente: mensaje.media_url ? "whatsapp_foto" : "whatsapp_manual",
      fecha: d.fecha ?? fechaLima(),
      foto_url: mensaje.media_url ?? null,
      ref_origen: "radar_ia",
      flota: unidad!.flota,
    });
    if (res.ok && res.estado === "aceptada") {
      // Registrada, pero hay dos casos que igual conviene que un humano revise: la PRIMERA
      // lectura de una unidad (se aceptó sin poder validarla) y un posible voucher mal
      // clasificado. En esos casos se deja también una alerta (el km ya quedó grabado igual).
      const avisos: string[] = [];
      if (esPrimeraLectura) avisos.push("Es la PRIMERA lectura de esta unidad: se aceptó como base sin poder validarla — confirmar que el número es correcto");
      if (sospechaVoucher) avisos.push("El mensaje menciona términos de compra (grifo/monto/voucher): revisar si en realidad era una recarga de combustible y no solo el odómetro");
      let alertaId: string | null = null;
      if (avisos.length) {
        alertaId = await crearAlerta(sb, {
          mensaje_id: mensaje.id,
          tipo: "odometro",
          severidad: "atencion",
          titulo: `🛞 Odómetro de ${unidad!.placa}${etiquetaFlota} registrado (${km!.toLocaleString("es-PE")} km) — conviene revisar`,
          detalle: `${avisos.join(" · ")} · ${dondeRevisar}`,
          href: hrefOdometro,
        });
      }
      return {
        accion: "odometro_registrado",
        detalle: `Lectura de ${unidad!.placa}${etiquetaFlota} registrada: ${km!.toLocaleString("es-PE")} km${avisos.length ? " (con aviso de revisión)" : ""}`,
        datos: { vehiculo_id: unidad!.id, flota: unidad!.flota, kilometraje: km, lectura_id: res.lecturaId, alerta_id: alertaId, primera_lectura: esPrimeraLectura, sospecha_voucher: sospechaVoucher },
      };
    }
    if (res.ok) {
      // "sospechosa"/"rechazada": registrarLectura YA la guardó sin tocar el vigente — solo falta avisar.
      const titulo = `🛞 Lectura de odómetro por revisar: ${unidad!.placa}${etiquetaFlota} — ${km!.toLocaleString("es-PE")} km`;
      const alertaId = await crearAlerta(sb, {
        mensaje_id: mensaje.id,
        tipo: "odometro_anomalia",
        severidad: "atencion",
        titulo,
        detalle: `${res.motivo ?? "Lectura fuera de rango"} · revisar y aceptar en ${dondeRevisar}`,
        href: hrefOdometro,
      });
      return {
        accion: "odometro_en_revision",
        detalle: `Lectura capturada pero quedó "${res.estado}" — revisar en ${dondeRevisar}`,
        datos: { vehiculo_id: unidad!.id, flota: unidad!.flota, kilometraje: km, lectura_id: res.lecturaId, alerta_id: alertaId, estado_lectura: res.estado },
      };
    }
    errorRegistro = res.error ?? "error desconocido";
  }

  // Sin automatización, sin match de placa, o sin kilometraje: alerta para registro manual.
  const motivos: string[] = [];
  if (config.acciones_automaticas?.odometro !== true) motivos.push("Registro automático de odómetro desactivado en la configuración");
  if (errorRegistro) motivos.push(`No se pudo grabar automáticamente: ${errorRegistro}`);
  if (!unidad) {
    motivos.push(
      d.placa
        ? `Placa ${placaFormato(d.placa)} no está registrada ni en la flota propia ni en la tercerizada`
        : "Mensaje sin placa identificable"
    );
  }
  if (km == null) motivos.push("Sin lectura de kilometraje");
  if (confianza < umbral) motivos.push(`Confianza ${Math.round(confianza * 100)}% por debajo del umbral ${Math.round(umbral * 100)}%`);
  if (sospechaVoucher) motivos.push("El mensaje menciona términos de compra (grifo/monto/voucher): revisar si era una recarga de combustible");

  const titulo = `🛞 Kilometraje reportado: ${unidad?.placa ?? placaFormato(d.placa) ?? d.unidad ?? "unidad sin identificar"}${etiquetaFlota}${km != null ? ` — ${km.toLocaleString("es-PE")} km` : ""}`;
  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "odometro",
    severidad: "info",
    titulo,
    detalle: motivos.join(" · ") || "Requiere registro manual",
    href: hrefOdometro,
  });

  return {
    accion: "odometro_pendiente",
    detalle: motivos[0] ?? `Requiere registro manual en ${dondeRevisar}`,
    datos: { alerta_id: alertaId, motivos, kilometraje: km, flota: unidad?.flota ?? null },
  };
}

// ── Mantenimiento ────────────────────────────────────────────────────────────

async function accionMantenimiento({ sb, mensaje, datos, confianza, config }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionMantenimiento;
  const veh = await matchVehiculo(sb, d.placa);
  const umbral = Number(config.umbral_confianza ?? 0.7);
  const urgente = d.urgente === true;
  let ordenId: number | null = null;
  let unidadBloqueada = false;

  const puedeAuto = config.acciones_automaticas?.mantenimiento === true && !!veh && confianza >= umbral;

  if (puedeAuto) {
    // Payload espejo del guardado de app/mantenimiento/_tabs/HistorialTab.tsx
    const { data: ins, error } = await sb
      .from("mantenimiento")
      .insert({
        vehiculo_id: veh!.id,
        fecha: d.fecha ?? fechaLima(),
        tipo: d.tipo ?? "correctivo",
        kilometraje: Number(veh!.kilometraje_actual ?? 0),
        descripcion: d.descripcion ?? d.tipo_trabajo ?? "Trabajo reportado por WhatsApp",
        proveedor: d.taller ?? null,
        costo: numOpc(d.costo) ?? 0,
        estado: "pendiente",
        proximo_km: 0,
        proxima_fecha: null,
        observaciones: firmaRadar(mensaje),
      })
      .select("id")
      .single();
    if (error) throw new Error(`mantenimiento: ${error.message}`);
    ordenId = Number((ins as any)?.id);

    // Unidad inoperativa: sacarla de la disponibilidad (bloquea asignaciones en /programacion)
    if (urgente) {
      const { error: errVeh } = await sb.from("vehiculos").update({ estado: "mantenimiento" }).eq("id", veh!.id);
      if (errVeh) throw new Error(`vehiculos: ${errVeh.message}`);
      unidadBloqueada = true;
    }
  }

  const severidad: SeveridadAlerta = urgente ? "critico" : "atencion";
  const titulo = `🔧 Mantenimiento: ${veh?.placa ?? placaFormato(d.placa) ?? d.unidad ?? "unidad"} — ${d.tipo_trabajo ?? d.descripcion ?? "trabajo reportado"}`;
  const partes: string[] = [];
  if (d.descripcion) partes.push(d.descripcion);
  if (d.taller) partes.push(`Taller: ${d.taller}`);
  if (numOpc(d.costo) != null) partes.push(`Costo ${fmtSoles(numOpc(d.costo)!)}`);
  if (urgente) partes.push("URGENTE: la unidad no puede operar");
  if (ordenId) partes.push(`Registro #${ordenId} creado en /mantenimiento`);
  if (unidadBloqueada) partes.push(`${veh!.placa} pasó a estado "mantenimiento" (no asignable)`);
  if (!puedeAuto && config.acciones_automaticas?.mantenimiento === true && !veh) partes.push("Sin match de placa: registrar manualmente");

  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "mantenimiento",
    severidad,
    titulo,
    detalle: partes.join(" · ") || null,
    href: "/mantenimiento",
  });

  return {
    accion: ordenId ? "orden_creada" : "alerta_mantenimiento",
    detalle: ordenId
      ? `Trabajo registrado en /mantenimiento (#${ordenId})${unidadBloqueada ? ` y ${veh!.placa} bloqueada por urgencia` : ""}`
      : `Alerta de mantenimiento creada${urgente ? " (unidad inoperativa)" : ""}`,
    datos: { mantenimiento_id: ordenId, alerta_id: alertaId, severidad, titulo, unidad_bloqueada: unidadBloqueada },
  };
}

// ── Operaciones ──────────────────────────────────────────────────────────────

async function accionOperaciones({ sb, mensaje, datos, confianza, config }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionOperacion;
  const veh = await matchVehiculo(sb, d.placa);
  const hoy = fechaLima();
  const evento = d.evento ?? "otro";
  const umbral = Number(config.umbral_confianza ?? 0.7);
  const refUnidad = veh?.placa ?? placaFormato(d.placa) ?? d.unidad ?? "unidad sin identificar";

  // Servicios de HOY de esa unidad en estados operables
  let reservasHoy: any[] = [];
  if (veh) {
    const { data } = await sb
      .from("reservas")
      .select("id, codigo, estado, hora_servicio, origen, destino")
      .eq("fecha_servicio", hoy)
      .eq("vehiculo_id", veh.id)
      .in("estado", ["programada", "confirmada", "en_curso"]);
    reservasHoy = (data as any[]) ?? [];
  }

  // Eventos que cambian estado (con transición válida): inicio y finalizo
  if (evento === "inicio" || evento === "finalizo") {
    const desde = evento === "inicio" ? "confirmada" : "en_curso";
    const candidatas = reservasHoy.filter((r) => r.estado === desde);
    const puedeAuto = config.acciones_automaticas?.operaciones === true && confianza >= umbral && candidatas.length === 1;

    if (puedeAuto) {
      const r = candidatas[0];
      const cambios =
        evento === "inicio"
          ? { estado: "en_curso", hora_real_inicio: horaLima() }
          : { estado: "finalizada", hora_real_fin: horaLima(), estado_admin: "por_liquidar" };
      // Doble filtro de estado: si otro proceso ya movió la reserva, no pisar nada
      const { error } = await sb.from("reservas").update(cambios).eq("id", r.id).eq("estado", desde);
      if (error) throw new Error(`reservas: ${error.message}`);

      const folio = r.codigo ?? `#${r.id}`;
      const titulo =
        evento === "inicio"
          ? `🚌 ${veh!.placa}: servicio ${folio} marcado EN CURSO`
          : `🚌 ${veh!.placa}: servicio ${folio} FINALIZADO (por liquidar)`;
      const alertaId = await crearAlerta(sb, {
        mensaje_id: mensaje.id,
        tipo: "operaciones",
        severidad: "info",
        titulo,
        detalle: `${d.detalle ?? "Reporte por WhatsApp"} · ${r.origen ?? ""} → ${r.destino ?? ""} · ${horaLima()} hora Lima`,
        href: "/seguimiento",
      });
      return {
        accion: "estado_actualizado",
        detalle:
          evento === "inicio"
            ? `Servicio ${folio} pasó a en_curso por reporte de WhatsApp`
            : `Servicio ${folio} pasó a finalizada (estado admin: por_liquidar)`,
        datos: { reserva_id: r.id, alerta_id: alertaId, severidad: "info", titulo, evento },
      };
    }

    // No se puede auto-actualizar: alerta con la sugerencia y el motivo
    const motivo = !veh
      ? "sin match de placa en la flota"
      : candidatas.length === 0
        ? `sin servicios de hoy en estado "${desde}"`
        : candidatas.length > 1
          ? `${candidatas.length} servicios de hoy coinciden (ambiguo)`
          : config.acciones_automaticas?.operaciones !== true
            ? "acción automática de operaciones desactivada"
            : `confianza ${Math.round(confianza * 100)}% por debajo del umbral`;
    const sugerencia = evento === "inicio" ? "marcar en curso" : "marcar finalizado";
    const titulo = `🚌 Operación reportada: ${refUnidad} — ${evento === "inicio" ? "inició servicio" : "finalizó servicio"}`;
    const alertaId = await crearAlerta(sb, {
      mensaje_id: mensaje.id,
      tipo: "operaciones",
      severidad: "atencion",
      titulo,
      detalle: `${d.detalle ?? "Reporte por WhatsApp"} · Sugerencia: ${sugerencia} el servicio de ${refUnidad} en /seguimiento (${motivo})`,
      href: "/seguimiento",
    });
    return {
      accion: "alerta_operacion",
      detalle: `No se actualizó el estado (${motivo}); se dejó la sugerencia en la alerta`,
      datos: { alerta_id: alertaId, severidad: "atencion", titulo, evento, motivo },
    };
  }

  // Eventos que NO cambian estado: solo alerta
  const severidad: SeveridadAlerta =
    evento === "cancelacion" ? "critico" : evento === "retraso" ? "atencion" : "info";
  const etiquetaEvento: Record<string, string> = {
    llego: "llegó al punto",
    abordo: "pasajeros abordados",
    retraso: "retraso reportado",
    cancelacion: "CANCELACIÓN reportada",
    otro: "novedad",
  };
  const titulo = `🚌 Operación: ${refUnidad} — ${etiquetaEvento[evento] ?? "novedad"}`;
  const detalleAlerta =
    evento === "cancelacion"
      ? `${d.detalle ?? "Cancelación reportada por WhatsApp"} · El Radar NUNCA cancela servicios: revisar y cancelar manualmente en /seguimiento si corresponde`
      : `${d.detalle ?? "Reporte por WhatsApp"}${d.hora ? ` · ${d.hora}` : ""}${reservasHoy.length ? ` · ${reservasHoy.length} servicio(s) de hoy con esa unidad` : ""}`;
  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "operaciones",
    severidad,
    titulo,
    detalle: detalleAlerta,
    href: "/seguimiento",
  });

  return {
    accion: "alerta_operacion",
    detalle: `Novedad de operación registrada (${etiquetaEvento[evento] ?? "novedad"})`,
    datos: { alerta_id: alertaId, severidad, titulo, evento },
  };
}

// ── Documentación ────────────────────────────────────────────────────────────

async function accionDocumentacion({ sb, mensaje, datos }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionDocumentacion;
  const dias = diasPara(d.fecha_vencimiento);
  const severidad: SeveridadAlerta =
    dias == null ? "info" : dias <= 7 ? "critico" : dias <= 30 ? "atencion" : "info";

  // Licencias / documentos de personas → /conductores; el resto → /documentos-vehiculares
  const esConductor = /licencia/i.test(d.tipo_documento ?? "") || (!!d.conductor && !d.placa);
  const href = esConductor ? "/conductores" : "/documentos-vehiculares";

  const sujeto = placaFormato(d.placa) ?? d.conductor ?? "";
  const titulo = `📄 Documentación: ${d.tipo_documento ?? "documento"}${sujeto ? ` de ${sujeto}` : ""}`;
  const partes: string[] = [];
  if (dias != null) {
    partes.push(
      dias < 0
        ? `VENCIDO hace ${Math.abs(dias)} día(s) (${d.fecha_vencimiento})`
        : dias === 0
          ? `Vence HOY (${d.fecha_vencimiento})`
          : `Vence en ${dias} día(s) (${d.fecha_vencimiento})`
    );
  }
  if (d.detalle) partes.push(d.detalle);

  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "documentacion",
    severidad,
    titulo,
    detalle: partes.join(" · ") || null,
    href,
  });

  return {
    accion: "alerta_documentacion",
    detalle: `Alerta de documentación creada (${severidad})`,
    datos: { alerta_id: alertaId, severidad, titulo, dias_para_vencer: dias },
  };
}

// ── Incidencias ──────────────────────────────────────────────────────────────

async function accionIncidencia({ sb, mensaje, datos }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionIncidencia;
  const severidad: SeveridadAlerta = d.gravedad === "alta" ? "critico" : "atencion";
  const refUnidad = placaFormato(d.placa) ?? d.unidad ?? "unidad sin identificar";
  const titulo = `⚠️ Incidencia: ${d.tipo_incidencia ?? "reporte"} — ${refUnidad}`;

  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "incidencia",
    severidad,
    titulo,
    detalle: [d.detalle, d.gravedad ? `Gravedad: ${d.gravedad}` : null].filter(Boolean).join(" · ") || null,
    href: "/incidencias",
  });

  return {
    accion: "alerta_incidencia",
    detalle: `Alerta de incidencia creada (${severidad})`,
    datos: { alerta_id: alertaId, severidad, titulo },
  };
}

// ── Cobranza ─────────────────────────────────────────────────────────────────

async function accionCobranza({ sb, mensaje, datos }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionCobranza;
  const monto = numOpc(d.monto);
  const severidad: SeveridadAlerta = monto != null && monto > 5000 ? "atencion" : "info";
  const quien = d.empresa ?? d.cliente ?? "cliente sin identificar";
  const titulo = `💰 Cobranza: ${quien}${monto != null ? ` · ${fmtSoles(monto)}` : ""}`;

  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "cobranza",
    severidad,
    titulo,
    detalle: [d.detalle, d.factura ? `Factura ${d.factura}` : null].filter(Boolean).join(" · ") || null,
    href: "/facturacion",
  });

  return {
    accion: "alerta_cobranza",
    detalle: `Alerta de cobranza creada (${severidad})`,
    datos: { alerta_id: alertaId, severidad, titulo, monto },
  };
}
