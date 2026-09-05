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

import { registrarLectura, contextoOdometro, type Flota, type ContextoOdometro } from "@/lib/odometro";
import { elegirOdometro } from "@/lib/odometro-seleccion";
import { revisarCoherenciaVoucher, numeroDeTranscripcion } from "./coherencia-voucher";
import { leerAlbumRecargas, buscarDuplicado, type RecargaAlbum, type DespachoGuardado } from "./album-recargas";
import { planificarReproceso, type ArtefactoPrevio, type PlanReproceso } from "./reproceso";
import {
  resolverIdentidadGrifo,
  normalizarDiscrepancias,
  esFalsaDiscrepancia,
  codigoDeDiscrepancia,
  detalleDeDiscrepancia,
  type EmpresasConocidas,
} from "./identidad-voucher";
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

/**
 * Fecha Lima (YYYY-MM-DD) de un timestamp dado — p.ej. cuándo se ENVIÓ el mensaje al grupo.
 * Al reprocesar una foto días después, la fecha de la lectura debe ser la del mensaje
 * original (ts_mensaje), no la del reproceso. Devuelve null si el ts no es válido.
 */
export function fechaLimaDeTs(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 5 * 3600 * 1000).toISOString().slice(0, 10);
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

// ── Empresas que el ERP conoce como suyas (para el guard de identidad del voucher) ──
// La propia (`empresa_perfil`, fila 1) y las tercerizadas. Ninguna puede ser el grifo de su
// propio voucher de combustible: en la nota de despacho son el CLIENTE que compró. Ver
// lib/radar/identidad-voucher.ts.
//
// Se memoiza por 5 minutos: son dos selects sobre tablas chicas, pero el lote procesa hasta
// 50 mensajes y no tiene sentido repetirlos por cada uno. Cinco minutos es corto de sobra
// para que una tercerizada recién dada de alta entre en el siguiente barrido del cron.
const TTL_EMPRESAS_MS = 5 * 60_000;
let _empresasConocidas: { data: EmpresasConocidas; en: number } | null = null;

async function cargarEmpresasConocidas(sb: any): Promise<EmpresasConocidas> {
  if (_empresasConocidas && Date.now() - _empresasConocidas.en < TTL_EMPRESAS_MS) return _empresasConocidas.data;
  const nombres: string[] = [];
  const rucs: string[] = [];
  // La propia va PRIMERA: identidad-voucher.ts la usa para decir "la propia empresa" en vez
  // de "una tercerizada" en el texto de la anomalía.
  try {
    const { data } = await sb.from("empresa_perfil").select("nombre, ruc").eq("id", 1).maybeSingle();
    if (data?.nombre) nombres.push(String(data.nombre));
    if (data?.ruc) rucs.push(String(data.ruc));
  } catch {
    // sin perfil de empresa: el guard sigue con las tercerizadas
  }
  // Respaldo por si el perfil está vacío: la misma variable que ya usan las notificaciones y
  // los pactos para firmar como la empresa. Nunca un nombre hardcodeado — este ERP se vende.
  if (!nombres.length && process.env.EMPRESA_NOMBRE) nombres.push(process.env.EMPRESA_NOMBRE);
  try {
    const { data } = await sb.from("empresas_tercerizadas").select("razon_social, ruc");
    for (const e of (data ?? []) as { razon_social?: string; ruc?: string }[]) {
      if (e.razon_social) nombres.push(String(e.razon_social));
      if (e.ruc) rucs.push(String(e.ruc));
    }
  } catch {
    // sin tabla de tercerizadas: el guard se abstiene con lo que tenga
  }
  const res: EmpresasConocidas = { nombres, rucs };
  _empresasConocidas = { data: res, en: Date.now() };
  return res;
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
export async function matchVehiculoTercero(
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

/** Trae un vehículo de la flota propia por id (mismo shape que matchVehiculo). */
async function vehiculoPorId(sb: any, id: number): Promise<VehiculoMatch | null> {
  try {
    const { data } = await sb.from("vehiculos").select("*").eq("id", id).maybeSingle();
    if (!data) return null;
    const hit = data as any;
    return {
      id: hit.id,
      placa: hit.placa,
      categoria: hit.categoria ?? null,
      kilometraje_actual: hit.kilometraje_actual != null ? Number(hit.kilometraje_actual) : null,
      capacidad_tanque: hit.capacidad_tanque ?? null,
    };
  } catch {
    return null;
  }
}

export type ConductorMatch = {
  id: number;
  nombre: string;
  telefono: string | null;
  /** Cómo se identificó: por su WhatsApp, por un nombre del voucher, o por la asignación del día. */
  via: "telefono" | "nombre" | "asignacion";
};

/** Teléfono peruano (9 díg.) desde un JID de WhatsApp: recorta el device (:NN) y el dominio (@...). */
function telDeJid(jid?: string | null): string {
  const base = String(jid ?? "").split("@")[0].split(":")[0];
  return base.replace(/\D/g, "").slice(-9);
}

/**
 * Identifica al conductor por el WhatsApp del remitente (contra `conductores.telefono`) o, en
 * su defecto, por un nombre leído del voucher. El chofer que envía la foto de la recarga casi
 * siempre es el de la unidad: cruzar su número evita que el operador re-teclee un dato que el
 * sistema ya tiene. Devuelve null (degradación limpia) si no hay match — la carga se registra igual.
 */
export async function matchConductor(
  sb: any,
  ref: { jid?: string | null; telefono?: string | null; nombre?: string | null }
): Promise<ConductorMatch | null> {
  try {
    const { data } = await sb.from("conductores").select("id, nombre, telefono").neq("estado", "de_baja");
    const filas = (data as any[]) ?? [];
    // 1) Por teléfono del remitente (últimos 9 dígitos) — la señal más directa de "quién lo envió".
    const tel = ref.jid ? telDeJid(ref.jid) : tel9(ref.telefono);
    if (tel.length === 9) {
      const hit = filas.find((c) => tel9(c.telefono) === tel);
      if (hit) return { id: Number(hit.id), nombre: hit.nombre, telefono: hit.telefono ?? null, via: "telefono" };
    }
    // 2) Por nombre leído del voucher (raro, pero si coincide con un chofer es una buena señal).
    const nom = ref.nombre ? norm(ref.nombre) : "";
    if (nom.length >= 3) {
      const exact = filas.find((c) => norm(String(c.nombre ?? "")) === nom);
      const cand =
        exact ??
        filas.find((c) => {
          const cn = norm(String(c.nombre ?? ""));
          return cn.length >= 3 && (cn.includes(nom) || nom.includes(cn));
        });
      if (cand) return { id: Number(cand.id), nombre: cand.nombre, telefono: cand.telefono ?? null, via: "nombre" };
    }
  } catch {
    // sin match: la carga se registra igual, solo sin conductor identificado
  }
  return null;
}

/** Trae un conductor por id (para el cruce inverso vehículo→chofer asignado del día). */
async function conductorPorId(sb: any, id: number): Promise<ConductorMatch | null> {
  try {
    const { data } = await sb.from("conductores").select("id, nombre, telefono").eq("id", id).maybeSingle();
    if (!data) return null;
    const c = data as any;
    return { id: Number(c.id), nombre: c.nombre, telefono: c.telefono ?? null, via: "asignacion" };
  } catch {
    return null;
  }
}

/** Única unidad (id) asignada a un conductor en una fecha; null si ninguna o si hay ambigüedad. */
async function vehiculoAsignadoAlConductor(sb: any, conductorId: number, fecha: string): Promise<number | null> {
  try {
    const { data } = await sb
      .from("reservas")
      .select("vehiculo_id")
      .eq("conductor_id", conductorId)
      .eq("fecha_servicio", fecha)
      .neq("estado", "cancelada");
    const ids = [...new Set(((data as any[]) ?? []).map((r) => r.vehiculo_id).filter(Boolean))];
    return ids.length === 1 ? Number(ids[0]) : null;
  } catch {
    return null;
  }
}

/** Único conductor (id) asignado a una unidad en una fecha; null si ninguno o si hay ambigüedad. */
async function conductorAsignadoAlVehiculo(sb: any, vehiculoId: number, fecha: string): Promise<number | null> {
  try {
    const { data } = await sb
      .from("reservas")
      .select("conductor_id")
      .eq("vehiculo_id", vehiculoId)
      .eq("fecha_servicio", fecha)
      .neq("estado", "cancelada");
    const ids = [...new Set(((data as any[]) ?? []).map((r) => r.conductor_id).filter(Boolean))];
    return ids.length === 1 ? Number(ids[0]) : null;
  } catch {
    return null;
  }
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
  /** Lo que dejó la corrida anterior de este mensaje. Lo llena `ejecutarAccion`. */
  previo?: PlanReproceso;
};

/**
 * Retira lo que la corrida ANTERIOR de este mensaje dejó propuesto, y devuelve qué comprometió
 * (para no repetirlo). Se ejecuta solo cuando el mensaje ya tiene `procesado_en`: el endpoint
 * de reproceso lo conserva, así que es la señal de "esto ya pasó por aquí" sin columna nueva.
 * Best-effort: si algo falla, el reproceso sigue — peor un duplicado que un mensaje perdido.
 */
async function retirarCorridaAnterior(sb: any, mensaje: any): Promise<PlanReproceso | undefined> {
  if (!mensaje?.id || !mensaje?.procesado_en) return undefined;
  try {
    const [rc, ro, ra] = await Promise.all([
      sb.from("radar_combustible").select("id, estado, combustible_id").eq("mensaje_id", mensaje.id),
      sb.from("radar_oportunidades").select("id, estado, cotizacion_id").eq("mensaje_id", mensaje.id),
      sb.from("radar_alertas").select("id").eq("mensaje_id", mensaje.id),
    ]);
    const previos: ArtefactoPrevio[] = [
      ...(((rc?.data as Record<string, unknown>[]) ?? []).map((r) => ({
        tabla: "radar_combustible" as const,
        id: String(r.id),
        estado: (r.estado as string) ?? null,
        comprometido: r.combustible_id == null ? null : Number(r.combustible_id),
      }))),
      ...(((ro?.data as Record<string, unknown>[]) ?? []).map((r) => ({
        tabla: "radar_oportunidades" as const,
        id: String(r.id),
        estado: (r.estado as string) ?? null,
        comprometido: r.cotizacion_id == null ? null : Number(r.cotizacion_id),
      }))),
      ...(((ra?.data as Record<string, unknown>[]) ?? []).map((r) => ({
        tabla: "radar_alertas" as const,
        id: String(r.id),
      }))),
    ];
    const plan = planificarReproceso(previos, mensaje.resultado);
    // Solo se borra lo que el plan autorizó: nunca una fila con una carga real detrás.
    for (const [tabla, ids] of Object.entries(plan.retirar) as [string, string[]][]) {
      if (ids.length) await sb.from(tabla).delete().in("id", ids);
    }
    return plan;
  } catch (e: unknown) {
    console.warn("[radar/acciones] no se pudo retirar la corrida anterior:", (e as Error)?.message ?? e);
    return undefined;
  }
}

export async function ejecutarAccion(args: ArgsAccion): Promise<ResultadoAccion> {
  try {
    // Reprocesar vuelve a correr la acción ENTERA, y las acciones insertan sin mirar si la
    // corrida anterior ya lo hizo: cada clic en "Reprocesar" duplicaba lo que el mensaje había
    // creado. Se retira antes lo PROPUESTO y se recuerda lo COMPROMETIDO para no repetirlo.
    args.previo = await retirarCorridaAnterior(args.sb, args.mensaje);
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

async function accionOportunidad({ sb, mensaje, datos, previo }: ArgsAccion): Promise<ResultadoAccion> {
  // Alguien ya cotizó, revisó o descartó la oportunidad de este mensaje: reprocesarlo no puede
  // abrir otra igual al lado, borrando de hecho ese trabajo de la vista del comercial.
  if (previo?.oportunidadTocada) {
    return {
      accion: "oportunidad_ya_trabajada",
      detalle:
        "Reproceso sin efecto: la oportunidad de este mensaje ya fue trabajada (cotizada, revisada o descartada). " +
        "No se crea otra para no duplicarla en la bandeja comercial.",
      datos: { reproceso: true },
    };
  }
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

/**
 * Abre una fila de `radar_combustible` por cada despacho ADICIONAL del álbum (el primero ya
 * tiene la suya, con el pipeline completo). Devuelve cuántas se crearon.
 *
 * Deliberadamente NO repite el pipeline entero —conductor por WhatsApp, consumo contra el
 * histórico, duplicados, cuadre— sobre cada extra: eso es un segundo camino con las reglas
 * escritas otra vez, y lo que hay que resolver acá es más simple y más urgente. Lo que sí hace
 * es lo único que el operador no puede rehacer a mano: **guardar los números del voucher que
 * si no se perdía**, con su placa ya cruzada contra la flota. El resto lo confirma la persona
 * que abre la fila con la foto delante, que es quien tiene que decidirlo igual.
 */
async function insertarRecargasAdicionales(
  sb: any,
  ctx: {
    album: RecargaAlbum[];
    mensajeId: string;
    fechaPorDefecto: string;
    grifoPorDefecto: string | null;
    fotos: { url: string; mime: string | null; nombre: string | null }[];
    conductor: string | null;
    proveedor: string | null;
    totalDespachos: number;
  }
): Promise<number> {
  if (!ctx.album.length) return 0;
  let creadas = 0;
  for (const [i, r] of ctx.album.entries()) {
    try {
      const veh = await matchVehiculo(sb, r.placa);
      const terc = veh ? null : await matchVehiculoTercero(sb, r.placa);
      const { error } = await sb.from("radar_combustible").insert({
        mensaje_id: ctx.mensajeId,
        placa: placaFormato(r.placa) ?? veh?.placa ?? terc?.placa ?? null,
        vehiculo_id: veh?.id ?? null,
        vehiculo_tercero_id: terc?.id ?? null,
        fecha: r.fecha || ctx.fechaPorDefecto,
        hora: r.hora,
        // El grifo del álbum es el mismo salvo que el voucher diga otro: son notas de la
        // misma ráfaga, casi siempre de la misma estación.
        grifo: r.grifo ?? ctx.grifoPorDefecto,
        tipo_combustible: r.tipoCombustible,
        galones: r.galones,
        litros: r.litros,
        precio_galon: r.precioGalon,
        precio_litro: r.precioLitro,
        monto_total: r.montoTotal,
        comprobante: r.comprobante,
        kilometraje: r.kilometraje,
        conductor: ctx.conductor,
        proveedor: ctx.proveedor,
        estado: "pendiente_revision",
        combustible_id: null,
        anomalias: [
          {
            codigo: "multiples_recargas_en_cluster",
            detalle:
              `Recarga ${i + 2} de ${ctx.totalDespachos} de una misma ráfaga de fotos${r.comprobante ? ` (comprobante ${r.comprobante})` : ""}. ` +
              `Se le abrió fila propia para no perderla al fusionarla con la primera; sus datos salen del voucher, ` +
              `pero el conductor y los controles de consumo no se le cruzaron — confírmala entera contra su foto.`,
            bloquea: true,
          },
        ],
        fotos: ctx.fotos,
      });
      if (error) throw new Error(error.message);
      creadas++;
    } catch (e: unknown) {
      // Una extra que falla no puede tumbar el reporte principal, que ya está guardado.
      console.warn("[radar/acciones] recarga adicional no guardada:", (e as Error)?.message ?? e);
    }
  }
  return creadas;
}

async function accionCombustible({ sb, mensaje, datos, confianza, config, previo }: ArgsAccion): Promise<ResultadoAccion> {
  // Este mensaje YA registró una carga real en `combustible`. Volver a procesarlo NO puede
  // crear una segunda: sería el mismo gasto contado dos veces en v_egresos, en el costo por km
  // y en el margen del servicio. Tampoco se borra la que existe — eso lo decide una persona en
  // /combustible, que es donde vive la fila autoritativa.
  if (previo?.combustibleId != null) {
    return {
      accion: "combustible_ya_registrado",
      detalle:
        `Reproceso sin efecto: este mensaje ya registró la carga #${previo.combustibleId} en /combustible. ` +
        `No se vuelve a registrar para no duplicar el gasto. Si hay que rehacerla, bórrala primero desde /combustible.`,
      datos: { combustible_id: previo.combustibleId, reproceso: true },
    };
  }
  const d = datos as ExtraccionCombustible;
  const fecha = d.fecha || fechaLimaDeTs(mensaje.ts_mensaje) || fechaLima();
  // La IA a veces deja una placa real (p.ej. "CUP 435" sin guion) en "unidad" en vez de
  // "placa" — placaNorm() quita espacios/guiones antes de comparar, así que probarla igual
  // contra la flota es seguro: una referencia realmente informal ("bus 45") no matchea nada.
  let veh = (await matchVehiculo(sb, d.placa)) ?? (await matchVehiculo(sb, d.unidad));
  // La flota de AFA es mayoritariamente TERCERIZADA: si la placa no está en `vehiculos` hay que
  // buscarla también en `vehiculos_tercero` y guardar esa FK. Sin esto el panel de revisión
  // mostraba "sin match" y pedía elegir la unidad a mano aunque la IA ya hubiera leído la placa.
  // (El auto-registro en `combustible` sigue siendo solo de flota propia — ver `puedeAuto`.)
  const terc = veh ? null : (await matchVehiculoTercero(sb, d.placa)) ?? (await matchVehiculoTercero(sb, d.unidad));

  // ── Cruce de identidad: rellenar conductor y placa con lo que el sistema ya sabe ──
  // Meta: que el operador no re-teclee datos deducibles. El chofer que envía la foto del
  // voucher casi siempre es el de la unidad → se identifica por su WhatsApp (remitente_wa).
  let condMatch = await matchConductor(sb, { jid: mensaje.remitente_wa, nombre: d.conductor });
  // Si el voucher no trae placa pero sí sabemos quién es el chofer, se infiere el vehículo
  // desde su única asignación del día (si es ambigua no se infiere, para no adivinar mal).
  // Solo cuando NO hay placa legible en el voucher: si la IA leyó una placa, esa manda —
  // inferir otra unidad del conductor cargaría el gasto a un vehículo que el voucher desmiente.
  let placaInferida = false;
  const placaLeida = placaNorm(d.placa).length >= 5;
  if (!veh && !terc && !placaLeida && condMatch) {
    const vid = await vehiculoAsignadoAlConductor(sb, condMatch.id, fecha);
    if (vid) {
      const inferido = await vehiculoPorId(sb, vid);
      if (inferido) {
        veh = inferido;
        placaInferida = true;
      }
    }
  }
  // Cruce inverso: hay placa pero el remitente no está en `conductores` (p.ej. lo reenvió un
  // coordinador) → se toma el único chofer asignado a esa unidad ese día.
  if (!condMatch && veh) {
    const cid = await conductorAsignadoAlVehiculo(sb, veh.id, fecha);
    if (cid) condMatch = await conductorPorId(sb, cid);
  }

  // Placa resuelta (leída del voucher o inferida) y nombre canónico del conductor identificado.
  const placa = placaFormato(d.placa) ?? veh?.placa ?? terc?.placa ?? null;
  const conductorNombre = condMatch?.nombre ?? d.conductor ?? null;
  const tipoComb = String(d.tipo_combustible || "diesel").toLowerCase();
  // Los tres números del voucher son `let`: el cuadre aritmético (más abajo) puede corregir
  // el que se leyó mal, y todos los controles siguientes —tanque, consumo, duplicado— tienen
  // que juzgar el número corregido, no el que ya se sabe equivocado.
  let cantidad = numOpc(d.galones) ?? numOpc(d.litros);
  let precioUnit = numOpc(d.precio_galon) ?? numOpc(d.precio_litro);
  let monto = numOpc(d.monto_total);
  const km = numOpc(d.kilometraje);
  // La cantidad se guarda en la columna que la IA usó (galones XOR litros). Se lleva aparte
  // para que una corrección aterrice en la misma columna de la que salió.
  let galonesFila = numOpc(d.galones);
  let litrosFila = numOpc(d.litros);
  let precioGalonFila = numOpc(d.precio_galon);
  let precioLitroFila = numOpc(d.precio_litro);
  const esLitros = galonesFila == null && litrosFila != null;
  const unidadCant = esLitros ? "lt" : "gal";
  const umbral = Number(config.umbral_confianza ?? 0.7);

  const anomalias: AnomaliaCombustible[] = [];

  // ── Campos del camino de VISIÓN multi-foto (opcionales; el de texto no los llena) ──
  const consumoTasa = numOpc(d.consumo_l_100km);
  const tripKm = numOpc(d.trip_km);
  const vioNota = d.vio_nota === true;
  const vioSurtidor = d.vio_surtidor === true;
  const vioTablero = d.vio_tablero === true;
  const discrepancias = normalizarDiscrepancias(d.discrepancias);

  // Identidad: el grifo/proveedor JAMÁS es una marca de kit GLP del tablero (trampa "LANDI RENZO").
  let grifo = d.grifo ?? null;
  let proveedor = d.proveedor ?? null;
  let direccionGrifo = d.direccion_grifo ?? null;
  if (esMarcaKitGLP(grifo) || esMarcaKitGLP(proveedor)) {
    anomalias.push({
      codigo: "marca_kit_como_grifo",
      detalle: `"${grifo ?? proveedor}" es la marca del kit de conversión a GLP del tablero, no un grifo — se ignoró como estación`,
      bloquea: true,
    });
    if (esMarcaKitGLP(grifo)) grifo = null;
    if (esMarcaKitGLP(proveedor)) proveedor = null;
  }

  // El grifo tampoco es quien COMPRÓ. La nota de despacho trae DOS empresas —el grifo en el
  // encabezado y el cliente en "RAZ.SOC"— y el segundo campo se llama literalmente "razón
  // social", así que ahí terminaban GLOBAL BUS PERÚ S.A.C. (la tercerizada dueña del bus) y
  // hasta AFA TOURS PERÚ S.A.C. El ERP tiene la evidencia que el modelo no puede tener: sabe
  // cómo se llama y quiénes son sus tercerizadas, y ninguna puede venderle combustible a AFA
  // en su propio voucher. Ver lib/radar/identidad-voucher.ts.
  // `radar_combustible` no guarda el RUC, así que del resultado solo se aplican el nombre y la
  // dirección; el RUC entra igual porque es la otra mitad de la prueba (el nombre puede estar
  // bien y el RUC salir del bloque del cliente, y ahí lo que sobra es la dirección).
  const identidad = resolverIdentidadGrifo(
    { grifo, proveedor, ruc: d.ruc ?? null, direccionGrifo, clienteEnNota: d.cliente_en_nota ?? null },
    await cargarEmpresasConocidas(sb)
  );
  grifo = identidad.grifo;
  proveedor = identidad.proveedor;
  direccionGrifo = identidad.direccionGrifo;
  if (identidad.anomalia) anomalias.push(identidad.anomalia);

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
  // Diferencias que reportó la IA: la NOTA manda (decisión del operador), así que quedan como
  // alerta informativa (no bloquean). Lo que SÍ cambia es la etiqueta: antes TODAS entraban
  // como "el surtidor no coincide con la nota", y en un reporte de dos fotos —la nota y el
  // TABLERO— eso acusaba a una máquina que nadie fotografió. Cada una declara entre qué dos
  // fuentes es, y se contrasta contra las fotos que de verdad se vieron: una comparación
  // contra una foto ausente baja a observación en vez de nombrar al surtidor.
  // Y antes de eso se descarta la que NO es una diferencia: la IA reportó como discrepancia el
  // odómetro de una nota (175,445 km) contra el de su tablero (175445 km) —el mismo número, con
  // la coma de miles leída como decimal— y su propio texto decía "es congruente con el de la
  // nota". Un rojo sobre una recarga correcta enseña a ignorar los rojos de verdad, así que la
  // discrepancia declara sus dos valores y acá se comprueban (ver `esFalsaDiscrepancia`).
  const fotosVistas = { vioSurtidor, vioNota, vioTablero };
  for (const disc of discrepancias) {
    if (esFalsaDiscrepancia(disc)) continue;
    anomalias.push({
      codigo: codigoDeDiscrepancia(disc, fotosVistas),
      detalle: detalleDeDiscrepancia(disc, fotosVistas),
      bloquea: false,
    });
  }

  // ── CUADRE ARITMÉTICO DEL VOUCHER ──────────────────────────────────────────
  // El papel trae CANTIDAD × PRECIO = IMPORTE, así que se verifica a sí mismo: cuando los
  // tres no dan, la división dice cuál se leyó mal y cuál es su valor. Va ANTES de todos los
  // controles de abajo a propósito — un galonaje mal leído hace mentir al consumo, al tanque
  // y al duplicado, y el revisor terminaba persiguiendo anomalías que no existían.
  // La corrección NUNCA auto-registra (bloquea: true): es una propuesta que una persona
  // confirma contra la foto, con el número ya puesto en el formulario.
  const cantidadIA = cantidad; // lo que la IA extrajo, antes de que el cuadre lo toque
  const cuadre = revisarCoherenciaVoucher({
    cantidad,
    precio: precioUnit,
    monto,
    cantidadTexto: d.texto_cantidad ?? null,
    unidad: unidadCant,
  });
  const corr = cuadre.correccion;
  if (corr && (cuadre.estado === "corregible" || cuadre.estado === "completado")) {
    if (corr.campo === "cantidad") {
      cantidad = corr.corregido;
      if (esLitros) litrosFila = corr.corregido;
      else galonesFila = corr.corregido;
    } else if (corr.campo === "precio") {
      precioUnit = corr.corregido;
      if (esLitros) precioLitroFila = corr.corregido;
      else precioGalonFila = corr.corregido;
    } else {
      monto = corr.corregido;
    }
    anomalias.push({
      codigo: cuadre.estado === "completado" ? "dato_derivado" : "lectura_corregida",
      detalle: cuadre.detalle,
      // Un dígito corregido SIEMPRE bloquea: sobre plata decide una persona. Un dato derivado
      // solo si es la CANTIDAD — un galonaje que nadie leyó no puede registrarse solo. El
      // precio y el importe derivados NO bloquean porque el ERP ya los derivaba en silencio
      // (`precioFinal = monto / cantidad` en el auto-registro, y `combustible.total` es una
      // columna generada): mandar a revisión lo que antes pasaba solo sería castigar al
      // operador con cola nueva por hacer explícita una cuenta que ya se hacía.
      bloquea: cuadre.estado === "corregible" || corr.campo === "cantidad",
      correccion: { campo: corr.campo, leido: corr.leido, corregido: corr.corregido, unidad: unidadCant },
    });
  } else if (cuadre.estado === "ambiguo") {
    anomalias.push({ codigo: "cuadre_ambiguo", detalle: cuadre.detalle, bloquea: true });
  }

  // La transcripción literal ("8.799x" copiado del papel) es una SEGUNDA lectura del mismo
  // número: si contradice a la que la IA puso en el campo, una de las dos está mal.
  // Se compara contra lo que la IA EXTRAJO, no contra el valor ya corregido: cuando el cuadre
  // corrigió la cantidad, la aritmética ya zanjó cuál de las dos era —levantar además esta
  // sería acusar dos veces el mismo dígito, y en rojo crítico sobre algo ya resuelto.
  // Y solo BLOQUEA cuando no hay cuenta que lo desempate: con los tres números cuadrando,
  // que la transcripción no calce es un descuido de copia, no una carga que registrar mal.
  const cantTexto = numeroDeTranscripcion(d.texto_cantidad);
  const cuadreCorrigioCantidad = corr?.campo === "cantidad";
  if (!cuadreCorrigioCantidad && cantTexto != null && cantidadIA != null && Math.abs(cantTexto - cantidadIA) > 0.0005) {
    anomalias.push({
      codigo: "cantidad_no_coincide_texto",
      detalle: `La IA extrajo ${cantidadIA} ${unidadCant} pero transcribió "${String(d.texto_cantidad).trim()}" del voucher — las dos lecturas del mismo número no coinciden${cuadre.estado === "cuadra" ? ", aunque la cantidad extraída sí cuadra con el precio y el importe" : ""}`,
      bloquea: cuadre.estado === "incompleto",
    });
  }

  // ── ¿LA RÁFAGA ES UN REPORTE O SON VARIOS DESPACHOS? ───────────────────────
  // El cluster agrupa por remitente y hora porque un reporte llega partido en varias fotos,
  // pero un conductor que cierra turno manda juntos los vouchers del DÍA. El 20-08 eso fusionó
  // dos notas de COESTI —CTV370 por S/ 180.03 y BUI272 por S/ 240.56, once horas aparte— en una
  // sola recarga con la placa de una y los números de la otra, y el segundo gasto desapareció.
  // `multiples_recargas_en_cluster` existía como código desde el día uno y NADIE lo levantaba.
  const album = leerAlbumRecargas(d, { comprobante: d.comprobante ?? null, placa, monto });
  if (album.multiple) {
    anomalias.push({
      codigo: "multiples_recargas_en_cluster",
      detalle: album.detalle,
      // Bloquea siempre: con dos despachos en la ráfaga, ni siquiera el principal es de fiar
      // hasta que alguien confirme cuál voucher describe cuál fila.
      bloquea: true,
    });
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
    if (!anomalias.some((a) => a.codigo === "posible_duplicado")) {
      // La identidad de un despacho es su NÚMERO DE NOTA, no su placa. El chequeo anterior
      // filtraba por `placa`, así que el mismo voucher V70S-00043064 entrando dos veces —una
      // atribuida a BUI-272 y otra a CTV-370— nunca se comparó consigo mismo y no avisó nada.
      // Se traen los candidatos por FECHA (un día de flota son pocas filas) y, aparte, por
      // comprobante sin restringir fecha: una foto reenviada días después sigue siendo el
      // mismo papel. `buscarDuplicado` decide; las reglas viven en un solo sitio.
      const candidatos = new Map<string, DespachoGuardado>();
      const sumar = (filas: unknown) => {
        for (const r of ((filas as Record<string, unknown>[]) ?? [])) {
          const id = String(r.id ?? "");
          // Las filas de ESTE mensaje no son un duplicado de sí mismas (un reproceso ya las
          // retiró; las adicionales del álbum son despachos distintos con su propia nota).
          if (!id || r.mensaje_id === mensaje.id) continue;
          candidatos.set(id, {
            id,
            placa: (r.placa as string) ?? null,
            fecha: (r.fecha as string) ?? null,
            comprobante: (r.comprobante as string) ?? null,
            monto: r.monto_total == null ? null : Number(r.monto_total),
            cantidad: r.galones != null ? Number(r.galones) : r.litros != null ? Number(r.litros) : null,
          });
        }
      };
      const cols = "id, mensaje_id, placa, fecha, comprobante, monto_total, galones, litros";
      const estados = ["registrado", "pendiente_revision"];
      const { data: delDia } = await sb.from("radar_combustible").select(cols).eq("fecha", fecha).in("estado", estados);
      sumar(delDia);
      if (d.comprobante) {
        const { data: porComp } = await sb
          .from("radar_combustible")
          .select(cols)
          .eq("comprobante", d.comprobante)
          .in("estado", estados);
        sumar(porComp);
      }
      const dup = buscarDuplicado(
        { placa, fecha, comprobante: d.comprobante ?? null, monto, cantidad },
        [...candidatos.values()]
      );
      if (dup) anomalias.push({ codigo: "posible_duplicado", detalle: dup.detalle });
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

  // 7) Cantidad × precio no cuadra con el total del voucher.
  //    El cuadre de arriba ya intentó explicarlo dígito a dígito; esto se queda con lo que
  //    NINGÚN error de lectura explica (un descuento del grifo, otro producto en el mismo
  //    comprobante) y hereda su detalle, que dice cuánto falta y por qué no se corrigió.
  //    Si el cuadre corrigió, los números de acá ya cuadran y esta anomalía no se levanta.
  if (cuadre.estado === "descuadra") {
    const calc = cantidad! * precioUnit!;
    if (Math.abs(calc - monto!) > Math.max(2, 0.05 * monto!)) {
      anomalias.push({ codigo: "monto_inconsistente", detalle: cuadre.detalle });
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

  // Todas las fotos del cluster (voucher/surtidor/tablero) que la IA procesó, para el panel de
  // revisión. Fallback a la foto propia del mensaje si el motor no las pasó.
  const fotosEvidencia: { url: string; mime: string | null; nombre: string | null }[] =
    (mensaje as { fotos_cluster?: { url: string; mime: string | null; nombre: string | null }[] }).fotos_cluster?.length
      ? (mensaje as { fotos_cluster: { url: string; mime: string | null; nombre: string | null }[] }).fotos_cluster
      : mensaje.media_url
        ? [{ url: mensaje.media_url, mime: mensaje.media_mime ?? null, nombre: mensaje.media_nombre ?? null }]
        : [];

  // Fila base para radar_combustible (se inserta SIEMPRE, con el estado que corresponda)
  const filaRadar: Record<string, unknown> = {
    mensaje_id: mensaje.id,
    placa,
    vehiculo_id: veh?.id ?? null,
    vehiculo_tercero_id: terc?.id ?? null,
    fecha,
    hora: d.hora ?? null,
    grifo,
    // La ya resuelta, no la cruda: cuando el "grifo" resultó ser el comprador, esta dirección
    // salía del mismo bloque "RAZ.SOC / RUC / DIRECC" y es la del cliente, no la de la estación.
    direccion_grifo: direccionGrifo,
    tipo_combustible: d.tipo_combustible ?? null,
    // Los números que el cuadre pudo corregir, no los crudos de la IA: el formulario de
    // revisión se llena de acá y el revisor tiene que ver el valor bueno ya puesto. Lo que
    // leyó la IA no se pierde — viaja en `anomalias[].correccion.leido`.
    galones: galonesFila,
    litros: litrosFila,
    precio_galon: precioGalonFila,
    precio_litro: precioLitroFila,
    monto_total: monto,
    comprobante: d.comprobante ?? null,
    kilometraje: km,
    conductor: conductorNombre,
    proveedor,
    anomalias,
    fotos: fotosEvidencia,
  };

  // ¿Se puede registrar automáticamente en la tabla real `combustible`?
  // El gate distingue anomalías BLOQUEANTES de observaciones (bloquea:false), así una discrepancia
  // informativa surtidor↔nota no frena una carga por lo demás correcta. La boleta única y clara
  // (una sola foto legible, sin observaciones) sigue auto-registrándose como antes.
  const sinBloqueantes = !anomalias.some((a) => a.bloquea !== false);
  const puedeAuto =
    config.acciones_automaticas?.combustible === true &&
    !!veh &&
    !placaInferida && // placa inferida (no leída del voucher) → siempre a revisión: no se carga gasto a una unidad adivinada
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
      (direccionGrifo ? ` · ${direccionGrifo}` : "");

    const { data: comb, error: errComb } = await sb
      .from("combustible")
      .insert({
        vehiculo_id: veh!.id,
        fecha,
        kilometraje: km ?? 0,
        galones: cantidad,
        precio_galon: precioFinal,
        grifo,
        conductor: conductorNombre,
        observaciones,
        tipo_combustible: d.tipo_combustible ?? "diesel",
        unidad: esLitros ? "litros" : "galones",
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
        capturado_en: mensaje.ts_mensaje ?? null,
        // El sello es de cuándo se ENVIÓ el mensaje: la foto del surtidor pudo tomarse antes.
        horaEsTope: true,
        // el km de una recarga se ata al mensaje → reproceso no duplica la lectura
        idemKey: `radar_odo_comb:${mensaje.id}`,
      });
    }

    const { error: errRadar } = await sb
      .from("radar_combustible")
      .insert({ ...filaRadar, estado: "registrado", combustible_id: combustibleId });
    if (errRadar) throw new Error(`radar_combustible: ${errRadar.message}`);

    return {
      accion: "combustible_registrado",
      detalle: `Carga de ${veh!.placa} registrada en /combustible: ${cantidad} ${unidadCant} de ${tipoComb}${monto != null ? ` por ${fmtSoles(monto)}` : ""}${conductorNombre ? ` · conductor ${conductorNombre}${condMatch?.via === "telefono" ? " (identificado por su WhatsApp)" : ""}` : ""}`,
      datos: { combustible_id: combustibleId, vehiculo_id: veh!.id, conductor: conductorNombre, conductor_via: condMatch?.via ?? null, anomalias },
    };
  }

  // Queda en revisión: registrar + alertar con los motivos
  const { data: rcIns, error: errRadar } = await sb
    .from("radar_combustible")
    .insert({ ...filaRadar, estado: "pendiente_revision", combustible_id: null })
    .select("id")
    .single();
  if (errRadar) throw new Error(`radar_combustible: ${errRadar.message}`);

  // El dígito que corrigió la aritmética se guarda como LECCIÓN, igual que si lo hubiera
  // corregido una persona en la pantalla: leccionesCombustible() la inyecta en el prompt de
  // visión y la próxima nota de despacho parecida se lee bien de entrada. Cerrar el ciclo sin
  // esperar a un humano es la diferencia entre corregir el mismo error todos los meses y
  // dejar de cometerlo. `usuario: "radar_ia"` es lo que distingue estas lecciones de las
  // humanas (la pantalla no llena esa columna), para que no ahoguen a las de una persona.
  if (corr && corr.leido != null && cuadre.estado === "corregible") {
    const { error: errLeccion } = await sb.from("radar_combustible_correcciones").insert({
      radar_combustible_id: (rcIns as { id?: string } | null)?.id ?? null,
      campo: corr.campo === "cantidad" ? (esLitros ? "litros" : "galones") : corr.campo,
      valor_ia: String(corr.leido),
      valor_correcto: String(corr.corregido),
      foto_url: fotosEvidencia[0]?.url ?? null,
      nota: `lo detectó el cuadre del voucher (cantidad × precio = importe), no una persona${corr.cambio ? ` · ${corr.cambio}` : ""}`,
      usuario: "radar_ia",
    });
    if (errLeccion) console.warn("[radar/acciones] lección de cuadre no guardada:", errLeccion.message);
  }

  // Cada despacho ADICIONAL del álbum recibe su propia fila. Sin esto, la segunda recarga —un
  // gasto real, con su placa y su importe— no quedaba en ninguna parte del ERP: la ráfaga
  // producía una sola fila y el resto se evaporaba. Van todas a `pendiente_revision` (nunca
  // auto-registro: si la ráfaga trajo dos vouchers, cuál describe a cuál lo confirma una
  // persona contra la foto), con las MISMAS fotos del cluster, que son su evidencia.
  const filasExtra = await insertarRecargasAdicionales(sb, {
    album: album.adicionales,
    mensajeId: mensaje.id,
    fechaPorDefecto: fecha,
    grifoPorDefecto: grifo,
    fotos: fotosEvidencia,
    conductor: conductorNombre,
    proveedor,
    totalDespachos: album.total,
  });

  const motivos: string[] = anomalias.map((a) => a.detalle);
  if (config.acciones_automaticas?.combustible !== true) motivos.push("Registro automático de combustible desactivado en la configuración");
  if (!veh) {
    if (terc) {
      motivos.push(`${terc.placa} es una unidad TERCERIZADA (${[terc.marca, terc.modelo].filter(Boolean).join(" ") || "sin marca/modelo"}) — no se registra automático, revisar manualmente si corresponde`);
    } else {
      motivos.push(placa ? `Placa ${placa} no está registrada en la flota propia ni en tercerizadas` : "Mensaje sin placa identificable");
    }
  }
  if (placaInferida)
    motivos.push(`Placa ${veh!.placa} inferida${condMatch ? ` del conductor ${condMatch.nombre}` : ""} (no venía en el voucher) — confirmar la unidad antes de registrar`);
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
      a.codigo === "voucher_no_leido" ||
      // Los números del voucher se contradicen y NADA los explica: la plata que se va a
      // registrar no es la del papel. Una corrección resuelta ("lectura_corregida") no
      // entra acá — deja el número bueno puesto y solo hay que confirmarlo, y la
      // transcripción que no calza sobre un voucher que SÍ cuadra tampoco (no bloquea).
      a.codigo === "cuadre_ambiguo" ||
      (a.codigo === "cantidad_no_coincide_texto" && a.bloquea !== false) ||
      // Dos vouchers en la misma ráfaga: hasta que alguien diga cuál describe cuál fila, no se
      // sabe de qué unidad es el gasto — y antes el segundo directamente se perdía.
      a.codigo === "multiples_recargas_en_cluster"
  )
    ? "critico"
    : "atencion";
  // Datos que el sistema YA rellenó por cruce (se muestran primero para que el operador vea
  // que solo debe confirmar, no re-teclear). "✅" los distingue de los motivos de revisión.
  const enriquecido: string[] = [];
  if (condMatch?.via === "telefono") enriquecido.push(`✅ Conductor identificado por su WhatsApp: ${condMatch.nombre}`);
  else if (condMatch?.via === "nombre") enriquecido.push(`✅ Conductor reconocido del voucher: ${condMatch.nombre}`);
  else if (condMatch?.via === "asignacion") enriquecido.push(`✅ Conductor tomado de la asignación del día: ${condMatch.nombre}`);
  if (placaInferida) enriquecido.push(`✅ Placa ${veh!.placa} inferida de la asignación del conductor`);

  const titulo = `⛽ Combustible por revisar: ${veh?.placa ?? placa ?? d.unidad ?? "unidad sin identificar"}${monto != null ? ` · ${fmtSoles(monto)}` : ""}`;
  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "combustible_anomalia",
    severidad,
    titulo,
    detalle: [...enriquecido, ...motivos].join(" · ") || "Requiere revisión manual",
    href: "/radar-ia?tab=combustible",
  });

  return {
    accion: "combustible_en_revision",
    detalle:
      `Carga capturada pero quedó en revisión: ${motivos[0] ?? "requiere revisión manual"}` +
      (filasExtra ? ` · ${filasExtra} recarga(s) más de la misma ráfaga quedaron en filas aparte` : ""),
    datos: {
      radar_combustible_id: (rcIns as any)?.id ?? null,
      alerta_id: alertaId,
      severidad,
      titulo,
      conductor: conductorNombre,
      conductor_via: condMatch?.via ?? null,
      placa_inferida: placaInferida,
      anomalias,
      motivos,
      recargas_adicionales: filasExtra,
      despachos_en_rafaga: album.total,
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
  // Mismo fallback que en combustible: si la IA dejó la placa en "unidad" (p.ej. "CUP 435"
  // sin guion), el match normalizado la encuentra igual; una referencia informal no matchea nada.
  const unidad = (await resolverUnidadOdometro(sb, d.placa)) ?? (await resolverUnidadOdometro(sb, d.unidad));

  // ── ¿Cuál de los números del tablero es el odómetro? ──────────────────────────────────
  // La IA transcribe bien el total y el parcial pero a veces los intercambia de campo (caso
  // BUI-272: kilometraje=1.803 / trip_km=174.159, con el bueno viajando en el JSON). El km
  // vigente de la unidad desempata sin ambigüedad. Degrada limpio: sin unidad o si la consulta
  // falla, el veredicto es neutro y el comportamiento es exactamente el de antes.
  let ctxOdo: ContextoOdometro | null = null;
  if (unidad) {
    try {
      ctxOdo = await contextoOdometro(sb, {
        vehiculo_id: unidad.id, flota: unidad.flota, tsRef: mensaje.ts_mensaje ?? null,
      });
    } catch {
      ctxOdo = null;
    }
  }
  const veredicto = elegirOdometro({
    kmIA: numOpc(d.kilometraje),
    tripIA: numOpc(d.trip_km),
    textoLeido: d.texto_leido ?? null,
    kmVigente: ctxOdo?.kmVigente ?? 0,
    kmDiaMax: ctxOdo?.kmDiaMax ?? 1500,
    horasDesdeUltima: ctxOdo?.horasDesdeUltima ?? null,
    hayHistorial: ctxOdo?.hayHistorial ?? false,
  });
  const km = veredicto.km;
  const kmCorregido = veredicto.origen === "corregido";
  const umbral = Number(config.umbral_confianza ?? 0.7);
  // Fecha de la lectura: la que dictó la IA (si vio una en la foto/texto), o la del MENSAJE
  // original (ts_mensaje) — así reprocesar días después conserva el día real, no el del proceso.
  const fechaOdo = d.fecha ?? fechaLimaDeTs(mensaje.ts_mensaje) ?? fechaLima();

  // ── Guards de auto-registro (Grupo D): el Radar es el ÚNICO camino que graba sin que un
  //    humano lo vea, así que exige más que "confianza de categoría alta". Cada guard que
  //    salta bloquea el auto y cae al flujo de alerta manual con su motivo.
  const esFoto = !!mensaje.media_url;
  const calidad = d.calidad_imagen ?? null;
  const confLectura = d.confianza_lectura != null ? Number(d.confianza_lectura) : null;
  const kmDigitos = km != null ? String(Math.round(km)).replace(/[^0-9]/g, "").length : 0;

  const calidadMala   = esFoto && calidad === "mala";                       // foto ilegible
  // La confianza de lectura solo aplica a FOTOS (en texto claro el prompt devuelve null).
  const lecturaDudosa = esFoto && confLectura != null && confLectura < umbral;
  // Un odómetro real tiene 3–7 dígitos (una unidad nueva puede ir en cientos de km).
  const kmImplausible = km != null && (kmDigitos < 3 || kmDigitos > 7);

  // Identidad: ¿la unidad de la foto es la que el conductor remitente tenía asignada el día en
  // que ENVIÓ el mensaje? Solo flota propia (la asignación por reserva usa vehiculo_id). Se usa
  // el día del mensaje (no la fecha declarada de la lectura). Degrada limpio si no hay match.
  const fechaAsignacion = fechaLimaDeTs(mensaje.ts_mensaje) ?? fechaLima();
  let placaAsignadaOtra: string | null = null;
  if (unidad && unidad.flota === "propia" && mensaje.remitente_wa) {
    const cond = await matchConductor(sb, { jid: mensaje.remitente_wa, nombre: d.conductor });
    if (cond) {
      const vidAsignado = await vehiculoAsignadoAlConductor(sb, cond.id, fechaAsignacion);
      if (vidAsignado != null && vidAsignado !== unidad.id) {
        const { data: vAsig } = await sb.from("vehiculos").select("placa").eq("id", vidAsignado).maybeSingle();
        placaAsignadaOtra = (vAsig as any)?.placa ?? `#${vidAsignado}`;
      }
    }
  }
  const identidadConflicto = placaAsignadaOtra != null;

  const bloqueos: string[] = [];
  if (calidadMala)   bloqueos.push("Foto del tablero ilegible (borrosa/reflejo/oscura) — pedir una nueva foto");
  if (lecturaDudosa) bloqueos.push(`La IA no está segura del número (confianza de lectura ${Math.round((confLectura ?? 0) * 100)}%)`);
  if (kmImplausible) bloqueos.push(`Kilometraje con ${kmDigitos} dígito(s): fuera del rango de un odómetro real`);
  if (identidadConflicto) bloqueos.push(`La foto es de ${unidad!.placa} pero quien la envió tiene asignada la ${placaAsignadaOtra} hoy — ¿foto de otra unidad?`);
  // OJO: el veredicto del selector NUNCA entra en `bloqueos`. Un bloqueo apaga `puedeAuto` y
  // entonces no se llama a registrarLectura, o sea que la lectura dejaría de existir como fila
  // y desaparecería de "Lecturas por revisar" — que es justo donde el operador la corrige y
  // donde nace el dataset de aprendizaje. El selector corrige el número cuando puede y, cuando
  // no puede, deja que la lectura entre igual y sea evaluarLectura quien la marque sospechosa.

  const puedeAuto = config.acciones_automaticas?.odometro === true
    && !!unidad && km != null && confianza >= umbral && bloqueos.length === 0;

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
      fecha: fechaOdo,
      foto_url: mensaje.media_url ?? null,
      ref_origen: "radar_ia",
      flota: unidad!.flota,
      capturado_en: mensaje.ts_mensaje ?? null,
      // `ts_mensaje` es cuándo se ENVIÓ, no cuándo se tomó la foto: el conductor fotografía el
      // tablero al arrancar y manda el mensaje después ("buenos días, km inicial"). Tratarlo
      // como hora exacta ponía la lectura detrás de check-ins posteriores y la acusaba de
      // retroceder. Ver [[project_odometro_hora_envio_vs_captura]].
      horaEsTope: true,
      idemKey: `radar_odo:${mensaje.id}`,
      // Deja rastro visible en la bandeja de que el número registrado no es el que devolvió
      // la IA (auditoría sin columnas nuevas). ref_origen sigue siendo "radar_ia" para no
      // sacar la lectura del panel de /radar-ia, que filtra por ese valor exacto.
      motivo: kmCorregido ? `Corregido por el sistema: ${veredicto.motivo}` : null,
    });
    if (res.ok && res.estado === "aceptada") {
      // Registrada, pero hay dos casos que igual conviene que un humano revise: la PRIMERA
      // lectura de una unidad (se aceptó sin poder validarla) y un posible voucher mal
      // clasificado. En esos casos se deja también una alerta (el km ya quedó grabado igual).
      const avisos: string[] = [];
      if (kmCorregido) avisos.push(`Lectura corregida automáticamente: ${veredicto.motivo}`);
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
        datos: { vehiculo_id: unidad!.id, flota: unidad!.flota, kilometraje: km, lectura_id: res.lecturaId, alerta_id: alertaId, primera_lectura: esPrimeraLectura, sospecha_voucher: sospechaVoucher, veredicto },
      };
    }
    if (res.ok) {
      // "sospechosa"/"rechazada": registrarLectura YA la guardó sin tocar el vigente — solo falta avisar.
      const titulo = `🛞 Lectura de odómetro por revisar: ${unidad!.placa}${etiquetaFlota} — ${km!.toLocaleString("es-PE")} km`;
      // Si el selector vio otro número posible en la MISMA foto, va en la alerta: es la pista
      // que convierte "revisa esto" en "¿era este otro número?".
      const pista = !veredicto.autoOk && veredicto.motivo ? ` · ${veredicto.motivo}` : "";
      const alertaId = await crearAlerta(sb, {
        mensaje_id: mensaje.id,
        tipo: "odometro_anomalia",
        severidad: "atencion",
        titulo,
        detalle: `${res.motivo ?? "Lectura fuera de rango"}${pista} · revisar y aceptar en ${dondeRevisar}`,
        href: hrefOdometro,
      });
      return {
        accion: "odometro_en_revision",
        detalle: `Lectura capturada pero quedó "${res.estado}" — revisar en ${dondeRevisar}`,
        datos: { vehiculo_id: unidad!.id, flota: unidad!.flota, kilometraje: km, lectura_id: res.lecturaId, alerta_id: alertaId, estado_lectura: res.estado, veredicto },
      };
    }
    errorRegistro = res.error ?? "error desconocido";
  }

  // Sin automatización, sin match de placa, o sin kilometraje: alerta para registro manual.
  const motivos: string[] = [];
  if (config.acciones_automaticas?.odometro !== true) motivos.push("Registro automático de odómetro desactivado en la configuración");
  if (errorRegistro) motivos.push(`No se pudo grabar automáticamente: ${errorRegistro}`);
  if (!unidad) {
    if (d.placa) {
      motivos.push(`Placa ${placaFormato(d.placa)} no está registrada ni en la flota propia ni en la tercerizada`);
    } else if (d.unidad) {
      motivos.push(`"${d.unidad}" no coincide con ninguna placa de la flota propia ni tercerizada`);
    } else {
      motivos.push("Mensaje sin placa identificable");
    }
  }
  if (km == null) motivos.push("Sin lectura de kilometraje");
  if (!veredicto.autoOk && veredicto.motivo) motivos.push(veredicto.motivo);
  if (confianza < umbral) motivos.push(`Confianza ${Math.round(confianza * 100)}% por debajo del umbral ${Math.round(umbral * 100)}%`);
  // Guards de lectura que bloquearon el auto-registro (calidad, trip, plausibilidad, identidad).
  for (const b of bloqueos) motivos.push(b);
  if (sospechaVoucher) motivos.push("El mensaje menciona términos de compra (grifo/monto/voucher): revisar si era una recarga de combustible");

  const titulo = `🛞 Kilometraje reportado: ${unidad?.placa ?? placaFormato(d.placa) ?? d.unidad ?? "unidad sin identificar"}${etiquetaFlota}${km != null ? ` — ${km.toLocaleString("es-PE")} km` : ""}`;
  // Si hubo señales de riesgo (foto ilegible, trip como total, otra unidad, posible voucher),
  // la alerta merece "atención"; el simple "falta registrar a mano" queda como "info".
  const severidadManual: SeveridadAlerta = bloqueos.length > 0 || sospechaVoucher ? "atencion" : "info";
  const alertaId = await crearAlerta(sb, {
    mensaje_id: mensaje.id,
    tipo: "odometro",
    severidad: severidadManual,
    titulo,
    detalle: motivos.join(" · ") || "Requiere registro manual",
    href: hrefOdometro,
  });

  return {
    accion: "odometro_pendiente",
    detalle: motivos[0] ?? `Requiere registro manual en ${dondeRevisar}`,
    datos: { alerta_id: alertaId, motivos, kilometraje: km, flota: unidad?.flota ?? null, veredicto },
  };
}

// ── Mantenimiento ────────────────────────────────────────────────────────────

async function accionMantenimiento({ sb, mensaje, datos, confianza, config, previo }: ArgsAccion): Promise<ResultadoAccion> {
  const d = datos as ExtraccionMantenimiento;
  const veh = await matchVehiculo(sb, d.placa);
  const umbral = Number(config.umbral_confianza ?? 0.7);
  const urgente = d.urgente === true;
  let ordenId: number | null = null;
  let unidadBloqueada = false;

  // Si este mensaje ya abrió una orden, reprocesarlo no abre otra: serían dos órdenes de
  // trabajo para el mismo reporte, y con `urgente` volvería a sacar la unidad de circulación.
  const puedeAuto =
    config.acciones_automaticas?.mantenimiento === true &&
    !!veh &&
    confianza >= umbral &&
    previo?.ordenMantenimientoId == null;

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
