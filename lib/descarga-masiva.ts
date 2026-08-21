// ══════════════════════════════════════════════════════════════════════════════
// lib/descarga-masiva.ts
// Descarga MASIVA de Manifiestos MTC y Reportes de Servicio agrupados por RUTA.
//
// "Misma ruta" = misma huella de paraderos + hora de CADA paradero + hora de salida
// (elección del usuario: "Paraderos + hora por parada"). Dos servicios que comparten esa
// huella se agrupan y se pueden bajar juntos en UN solo PDF (un servicio por página).
//
// Dos fases, a propósito:
//   1) cargarServiciosRango()  — barato: reservas + paraderos + conteos de un RANGO de
//      fechas, paginado (evita el truncado a 1000 filas de PostgREST que ya mordió antes,
//      ver lib/huella.ts paginarFilas). Con esto se arma la lista y los grupos de ruta.
//   2) construir*LoteHTML()    — pesado (PII): SOLO para los servicios seleccionados carga
//      el roster nominal (nombre/DNI/edad) y arma el HTML. El resto (conductor, placa, RUC,
//      cliente) ya viaja en cada ServicioLote desde la fase 1.
//
// La regla de roster (dedupe por pasajero + entradas "sin paradero") es la MISMA que usa
// cargarDocDatos() en app/seguimiento (documento suelto). Si cambia una, cambiar la otra.
// ══════════════════════════════════════════════════════════════════════════════

import { supabase } from "@/lib/supabase";
import { paginarFilas } from "@/lib/huella";
import { ESTADOS_RESERVA } from "@/lib/estados";
import {
  esAbordado,
  manifiestosMtcLoteHTML,
  reportesLoteHTML,
  type DocPasajero,
  type DatosServicioDoc,
  type LoteMeta,
} from "@/lib/documentos-servicio";

// ─── Tipos ────────────────────────────────────────────────────────────────────
export type EmpresaPerfilLite = { nombre: string | null; logo_url: string | null; telefono: string | null; email: string | null };
export type ParadaLite = { id: number; orden: number; nombre: string; hora_estimada: string | null };
type ReservaLite = {
  id: number; tipo: string; estado: string;
  fecha_servicio: string | null; hora_servicio: string | null;
  hora_real_inicio: string | null; hora_real_fin: string | null;
  origen: string | null; destino: string | null;
};

export type ServicioLote = {
  id: number;                                   // = reserva.id
  reserva: ReservaLite;
  paradas: ParadaLite[];
  cliente_nombre: string;
  cliente_ruc: string | null;
  vehiculo_placa: string | null;
  conductor: { nombre: string | null; licencia: string | null } | null;
  es_ter: boolean;
  sentido: "ida" | "retorno" | null;   // IDA / RETORNO (canónico o heurística de fijos)
  pax_total: number;
  gastos_total: number;
  firma_ruta: string;
  origen: string;
  destino: string;
  // Elegibilidad (misma regla que el documento suelto en /seguimiento):
  puede_manifiesto: boolean;  motivo_manifiesto: string | null;   // MTC: no cancelada + con pasajeros
  puede_reporte: boolean;     motivo_reporte: string | null;      // Reporte: en curso o finalizada
};

export type GrupoRuta = {
  firma: string;
  titulo: string;             // "ORIGEN → DESTINO"
  paraderos: number;
  horaSalida: string;         // "HH:MM"
  servicios: ServicioLote[];  // ordenados por fecha + hora
  fechaMin: string | null;
  fechaMax: string | null;
};

// ─── Sentido IDA / RETORNO ──────────────────────────────────────────────────────
// Réplica EXACTA de sentidoServicio() en app/programacion: prioriza el campo canónico
// `direccion_servicio`; si falta, heurística conservadora SOLO para fijos (eventuales → null).
const TIPOS_SERVICIO_FIJO = new Set(["transporte_personal", "fijo_solo_ida", "fijo_multiparada", "fijo_reten"]);
function sentidoServicio(r: any): "ida" | "retorno" | null {
  if (r.direccion_servicio === "ida") return "ida";
  if (r.direccion_servicio === "retorno") return "retorno";
  if (!TIPOS_SERVICIO_FIJO.has(r.tipo_servicio_detalle || "")) return null; // eventual → no se afirma
  if (r.tipo_servicio_detalle === "fijo_solo_ida") return "ida";
  if (r.reserva_vinculada_id != null) return "retorno";
  return null;
}

// ─── Firma de ruta (paraderos + hora por parada + hora de salida) ───────────────
const normNombre = (s?: string | null): string => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function firmaRuta(
  horaSalida: string | null | undefined,
  paradas: { orden: number; nombre: string; hora_estimada?: string | null }[],
): string {
  const hs = (horaSalida || "").slice(0, 5);
  const parts = [...paradas]
    .sort((a, b) => a.orden - b.orden)
    .map(p => `${p.orden}|${normNombre(p.nombre)}|${(p.hora_estimada || "").slice(0, 5)}`);
  return `${hs}#${parts.join(">")}`;
}

// ─── Utilidades internas ────────────────────────────────────────────────────────
// Trae filas por lotes de IDs (evita URLs kilométricas de .in()) y pagina cada lote
// (evita el corte a 1000 filas). `ordenCols` deben dar un orden ESTABLE por página.
async function inChunksPaginado(
  tabla: string, columnas: string, campo: string, ids: number[], ordenCols: string[], chunk = 80,
): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const sub = ids.slice(i, i + chunk);
    if (!sub.length) continue;
    const filas = await paginarFilas(() => {
      let q: any = supabase.from(tabla).select(columnas).in(campo, sub);
      for (const c of ordenCols) q = q.order(c);
      return q;
    }, 200000);
    out.push(...filas);
  }
  return out;
}

// Ejecuta fn sobre items con un tope de concurrencia (no dispares 30 cargas de roster a la vez).
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; res[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return res;
}

const estadoLabel = (e: string): string => (ESTADOS_RESERVA as any)[e]?.label || e;

// ══════════════════════════════════════════════════════════════════════════════
// FASE 1 — cargar servicios de un rango de fechas y armar los ServicioLote
// ══════════════════════════════════════════════════════════════════════════════
export async function cargarServiciosRango(
  desde: string, hasta: string,
): Promise<{ servicios: ServicioLote[]; empresa: EmpresaPerfilLite }> {
  // Reservas del rango (paginado, orden estable con id de desempate).
  const reservas = await paginarFilas(() =>
    supabase.from("reservas")
      .select("id,tipo,estado,fecha_servicio,hora_servicio,hora_real_inicio,hora_real_fin,origen,destino,cliente_id,vehiculo_id,conductor_id,conductor_tercero_id,empresa_tercerizada_id,vehiculo_tercero_id,direccion_servicio,tipo_servicio_detalle,reserva_vinculada_id")
      .gte("fecha_servicio", desde).lte("fecha_servicio", hasta)
      .in("estado", ["programada", "confirmada", "en_curso", "finalizada", "cancelada"])
      .order("fecha_servicio").order("hora_servicio").order("id"),
    30000);

  const empresaProm = supabase.from("empresa_perfil").select("nombre,logo_url,telefono,email").eq("id", 1).maybeSingle();

  // Tablas de referencia (pequeñas, pero se paginan por las dudas).
  const [clientes, vehiculos, vehsTer, conductores, conductoresTer] = await Promise.all([
    paginarFilas(() => supabase.from("clientes").select("id,nombre,empresa,ruc").order("id"), 50000),
    paginarFilas(() => supabase.from("vehiculos").select("id,placa").order("id"), 50000),
    paginarFilas(() => supabase.from("vehiculos_tercero").select("id,placa").order("id"), 50000),
    paginarFilas(() => supabase.from("conductores").select("id,nombre,numero_licencia:licencia").order("id"), 50000),
    paginarFilas(() => supabase.from("conductores_tercero").select("id,nombre,licencia").order("id"), 50000),
  ]);

  const reservaIds = reservas.map((r: any) => r.id);
  const [paradas, gastos, paxAdhoc] = await Promise.all([
    inChunksPaginado("paradas", "id,reserva_id,orden,nombre,hora_estimada", "reserva_id", reservaIds, ["reserva_id", "orden", "id"]),
    inChunksPaginado("gastos", "reserva_id,monto", "reserva_id", reservaIds, ["reserva_id", "id"]),
    inChunksPaginado("pasajeros", "id,reserva_id", "reserva_id", reservaIds, ["reserva_id", "id"]),
  ]);
  const paradaIds = paradas.map((p: any) => p.id);
  const pasajParada = await inChunksPaginado(
    "pasajeros_parada", "parada_id,pasajero_id,estado,estado_abordaje", "parada_id", paradaIds, ["parada_id", "pasajero_id"], 150,
  );

  // Índices en memoria.
  const cliMap = new Map<number, any>(clientes.map((c: any) => [c.id, c]));
  const vehMap = new Map<number, any>(vehiculos.map((v: any) => [v.id, v]));
  const vehTerMap = new Map<number, any>(vehsTer.map((v: any) => [v.id, v]));
  const condMap = new Map<number, any>(conductores.map((c: any) => [c.id, c]));
  const condTerMap = new Map<number, any>(conductoresTer.map((c: any) => [c.id, c]));
  const paradaToReserva = new Map<number, number>(paradas.map((p: any) => [p.id, p.reserva_id]));

  const paradasPorReserva = new Map<number, ParadaLite[]>();
  for (const p of paradas as any[]) {
    const arr = paradasPorReserva.get(p.reserva_id) || [];
    arr.push({ id: p.id, orden: p.orden, nombre: p.nombre, hora_estimada: p.hora_estimada ?? null });
    paradasPorReserva.set(p.reserva_id, arr);
  }
  const gastoPorReserva = new Map<number, number>();
  for (const g of gastos as any[]) gastoPorReserva.set(g.reserva_id, (gastoPorReserva.get(g.reserva_id) || 0) + Number(g.monto || 0));

  // Pasajeros esperados por reserva = unión(pasajeros.reserva_id, pasajeros_parada vía paradas).
  const esperados = new Map<number, Set<number>>();
  const ensure = (rid: number) => { let s = esperados.get(rid); if (!s) { s = new Set(); esperados.set(rid, s); } return s; };
  for (const p of paxAdhoc as any[]) ensure(p.reserva_id).add(p.id);
  for (const pp of pasajParada as any[]) {
    const rid = paradaToReserva.get(pp.parada_id); if (rid == null) continue;
    ensure(rid).add(pp.pasajero_id);
  }

  const servicios: ServicioLote[] = (reservas as any[]).map((r) => {
    const esTer = r.tipo === "tercerizada";
    const cli = r.cliente_id != null ? cliMap.get(r.cliente_id) : null;
    const cliente_nombre = cli?.empresa || cli?.nombre || "Sin cliente";
    const placa = esTer ? (vehTerMap.get(r.vehiculo_tercero_id)?.placa ?? null) : (vehMap.get(r.vehiculo_id)?.placa ?? null);
    const condRow = esTer ? condTerMap.get(r.conductor_tercero_id) : condMap.get(r.conductor_id);
    const conductor = condRow
      ? { nombre: condRow.nombre ?? null, licencia: (esTer ? condRow.licencia : condRow.numero_licencia) ?? null }
      : null;
    const paradasR = (paradasPorReserva.get(r.id) || []).slice().sort((a, b) => a.orden - b.orden);
    const pax_total = esperados.get(r.id)?.size || 0;
    const origen = (r.origen && String(r.origen).trim()) || paradasR[0]?.nombre || "—";
    const destino = (r.destino && String(r.destino).trim()) || paradasR[paradasR.length - 1]?.nombre || "—";

    const cancelada = r.estado === "cancelada";
    const puede_manifiesto = !cancelada && pax_total > 0;
    const motivo_manifiesto = cancelada ? "Servicio cancelado" : pax_total === 0 ? "Sin pasajeros registrados" : null;
    const puede_reporte = r.estado === "en_curso" || r.estado === "finalizada";
    const motivo_reporte = puede_reporte ? null : cancelada ? "Servicio cancelado" : "El servicio aún no inicia";

    return {
      id: r.id,
      reserva: {
        id: r.id, tipo: r.tipo, estado: r.estado,
        fecha_servicio: r.fecha_servicio, hora_servicio: r.hora_servicio,
        hora_real_inicio: r.hora_real_inicio ?? null, hora_real_fin: r.hora_real_fin ?? null,
        origen: r.origen ?? null, destino: r.destino ?? null,
      },
      paradas: paradasR,
      cliente_nombre, cliente_ruc: cli?.ruc ?? null,
      vehiculo_placa: placa, conductor, es_ter: esTer, sentido: sentidoServicio(r),
      pax_total, gastos_total: gastoPorReserva.get(r.id) || 0,
      firma_ruta: firmaRuta(r.hora_servicio, paradasR),
      origen, destino,
      puede_manifiesto, motivo_manifiesto, puede_reporte, motivo_reporte,
    };
  });

  const { data: empData } = await empresaProm;
  const empresa: EmpresaPerfilLite = (empData as any) || { nombre: null, logo_url: null, telefono: null, email: null };
  return { servicios, empresa };
}

// ─── Agrupar por huella de ruta ─────────────────────────────────────────────────
export function agruparPorRuta(servicios: ServicioLote[]): GrupoRuta[] {
  const grupos = new Map<string, GrupoRuta>();
  for (const s of servicios) {
    let g = grupos.get(s.firma_ruta);
    if (!g) {
      g = {
        firma: s.firma_ruta,
        titulo: `${s.origen} → ${s.destino}`,
        paraderos: s.paradas.length,
        horaSalida: (s.reserva.hora_servicio || "").slice(0, 5) || "—",
        servicios: [], fechaMin: null, fechaMax: null,
      };
      grupos.set(s.firma_ruta, g);
    }
    g.servicios.push(s);
  }
  const arr = [...grupos.values()];
  for (const g of arr) {
    g.servicios.sort((a, b) =>
      (a.reserva.fecha_servicio || "").localeCompare(b.reserva.fecha_servicio || "") ||
      (a.reserva.hora_servicio || "").localeCompare(b.reserva.hora_servicio || ""));
    const fechas = g.servicios.map(s => s.reserva.fecha_servicio).filter(Boolean) as string[];
    g.fechaMin = fechas.length ? fechas[0] : null;
    g.fechaMax = fechas.length ? fechas[fechas.length - 1] : null;
  }
  // Rutas con más servicios primero (las que más se repiten = las de mayor valor a granel).
  arr.sort((a, b) => b.servicios.length - a.servicios.length || a.titulo.localeCompare(b.titulo));
  return arr;
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 2 — roster nominal por servicio (solo los seleccionados) + armado del HTML
// ══════════════════════════════════════════════════════════════════════════════
// Réplica de la regla de cargarDocDatos() en app/seguimiento: dedupe por pasajero
// (preferir la fila abordada) + entradas sintéticas para pasajeros sin paradero + edad
// resiliente (consulta aislada; si la columna faltara, el manifiesto muestra "–").
async function cargarRoster(s: ServicioLote): Promise<DocPasajero[]> {
  const paradaIds = s.paradas.map(p => p.id);
  const [ppRes, paxRes] = await Promise.all([
    paradaIds.length
      ? supabase.from("pasajeros_parada").select("*, pasajero:pasajeros(nombre,dni)").in("parada_id", paradaIds)
      : Promise.resolve({ data: [] as any[] }),
    supabase.from("pasajeros").select("id,nombre,dni").eq("reserva_id", s.id),
  ]);
  const ppRaw = ((ppRes as any).data as any[]) || [];

  const porPax = new Map<number, any>();
  for (const x of ppRaw) {
    const prev = porPax.get(x.pasajero_id);
    if (!prev || (!esAbordado(prev) && esAbordado(x))) porPax.set(x.pasajero_id, x);
  }
  const pp = [...porPax.values()];
  const asignados = new Set(pp.map(x => x.pasajero_id));
  const sinParada = (((paxRes as any).data as any[]) || [])
    .filter(p => !asignados.has(p.id))
    .map(p => ({ parada_id: null, pasajero_id: p.id, estado: "Pendiente", estado_abordaje: null, hora_abordaje: null, pasajero: { nombre: p.nombre, dni: p.dni } }));
  const roster: DocPasajero[] = [...pp, ...sinParada];

  const idsPax = [...new Set(roster.map(x => x.pasajero_id).filter(Boolean))];
  if (idsPax.length > 0) {
    const { data: edades } = await supabase.from("pasajeros").select("id,edad").in("id", idsPax);
    if (edades) {
      const em = new Map((edades as any[]).map(e => [e.id, e.edad]));
      roster.forEach(x => { if (x.pasajero) (x.pasajero as any).edad = em.get(x.pasajero_id) ?? null; });
    }
  }
  return roster;
}

function rangoTexto(items: ServicioLote[]): string {
  const fechas = items.map(s => s.reserva.fecha_servicio).filter(Boolean) as string[];
  if (!fechas.length) return "—";
  const fmt = (f: string) => new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const min = fechas.reduce((a, b) => (a < b ? a : b));
  const max = fechas.reduce((a, b) => (a > b ? a : b));
  return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
}

function buildMeta(tituloDoc: string, sel: ServicioLote[], empresa: EmpresaPerfilLite): LoteMeta {
  const first = sel[0];
  const ruta = first
    ? `${first.origen} → ${first.destino} · ${first.paradas.length} paraderos · ${(first.reserva.hora_servicio || "").slice(0, 5) || "—"}`
    : "";
  return {
    tituloDoc, ruta, rango: rangoTexto(sel),
    empresaNombre: empresa.nombre ?? null,
    logoUrl: empresa.logo_url ?? null,
    items: sel.map(s => ({
      fecha: s.reserva.fecha_servicio, cliente: s.cliente_nombre,
      placa: s.vehiculo_placa, pax: s.pax_total, estado: estadoLabel(s.reserva.estado), sentido: s.sentido,
    })),
  };
}

// Manifiestos MTC combinados (uno por página + carátula). Devuelve el HTML listo para imprimir.
export async function construirManifiestosLoteHTML(sel: ServicioLote[], empresa: EmpresaPerfilLite): Promise<string> {
  const conRoster = await mapLimit(sel, 6, async (s) => ({ s, roster: await cargarRoster(s) }));
  const docs: DatosServicioDoc[] = conRoster.map(({ s, roster }) => ({
    empresa: { logoUrl: empresa.logo_url ?? null },
    cliente: { nombre: s.cliente_nombre },
    servicio: { fecha: s.reserva.fecha_servicio, hora: s.reserva.hora_servicio, origen: s.origen, destino: s.destino },
    conductor: s.conductor,
    vehiculo: { placa: s.vehiculo_placa },
    pasajeros: roster,
    boarding: [],
  }));
  return manifiestosMtcLoteHTML(docs, buildMeta("Manifiestos de Pasajeros (MTC)", sel, empresa));
}

// Reportes de Servicio combinados (uno por página + carátula).
export async function construirReportesLoteHTML(sel: ServicioLote[], empresa: EmpresaPerfilLite): Promise<string> {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const conRoster = await mapLimit(sel, 6, async (s) => ({ s, roster: await cargarRoster(s) }));
  const docs: DatosServicioDoc[] = conRoster.map(({ s, roster }) => {
    const ini = s.reserva.hora_real_inicio || null;
    const fin = s.reserva.hora_real_fin || null;
    const hayOp = !!(ini || fin || (s.gastos_total || 0) > 0);
    const duracionMin = ini && fin ? Math.max(0, toMin(fin) - toMin(ini)) : null;
    return {
      empresa: {
        nombre: empresa.nombre ?? null, telefono: empresa.telefono ?? null, email: empresa.email ?? null,
        logoReporteUrl: origin + "/logoafacotizacion-removebg-preview.png",
        firmaUrl: origin + "/firmaJLCA.png",
      },
      cliente: { nombre: s.cliente_nombre, ruc: s.cliente_ruc },
      servicio: { fecha: s.reserva.fecha_servicio, hora: s.reserva.hora_servicio, origen: s.origen, destino: s.destino },
      paradas: s.paradas.map(p => ({ id: p.id, orden: p.orden, nombre: p.nombre, hora_estimada: p.hora_estimada })),
      pasajeros: roster,
      boarding: [],
      operativo: hayOp ? {
        horaRealInicio: ini ? ini.slice(0, 5) : null,
        horaRealFin: fin ? fin.slice(0, 5) : null,
        duracionMin, gastosTotal: s.gastos_total ?? null, gpsUrl: null,
      } : null,
    };
  });
  return reportesLoteHTML(docs, buildMeta("Reportes de Servicio", sel, empresa));
}
