"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Reserva       = { id: number; origen: string; destino: string; fecha_servicio: string | null; hora_servicio: string | null; tipo: string; estado: string; precio_cliente: number; costo_proveedor: number; margen: number; cliente_id: number | null; vehiculo_id: number | null; conductor_id: number | null; tipo_asignacion?: string | null; empresa_tercerizada_id?: number | null; };
type Vehiculo      = { id: number; placa: string; categoria: string | null; estado: string | null; estado_operativo: string | null; kilometraje_actual: number | null; proximo_mantenimiento_km: number | null; };
type Conductor     = { id: number; nombre: string; estado: string | null; vencimiento_licencia: string | null; };
type Seguro        = { id: number; tipo: string; fecha_vencimiento: string | null; aseguradora: string | null; vehiculo_id: number | null; };
type Mantenimiento = { id: number; costo: number; tipo: string | null; proxima_fecha: string | null; estado: string | null; vehiculo_id: number | null; };
type Combustible   = { id: number; total: number; fecha: string | null; vehiculo_id: number | null; };
type DocVehiculo   = { id: number; vehiculo_id: number; tipo: string; fecha_vencimiento: string | null; };
type Neumatico     = { id: number; vehiculo_id: number | null; km_actual: number | null; km_instalacion: number | null; vida_util_km: number | null; estado: string; cocada_actual: number | null; cocada_nueva: number | null; costo_compra: number | null; };
type EmpresaTer    = { id: number; razon_social: string; estado: string; };
type DocTercero    = { id: number; empresa_id: number; tipo: string; fecha_vencimiento: string | null; };
type Factura       = { id: number; total: number; estado: string; fecha_emision: string | null; };
type Gasto         = { id: number; monto: number; categoria: string | null; fecha: string | null; };

// ─── SEMÁFORO ─────────────────────────────────────────────────────────────────

type SemaforoEstado = "verde" | "amarillo" | "rojo";
const SEMAFORO_CFG = {
  verde:    { bg: "#dcfce7", color: "#166534", dot: "#16a34a", label: "Operativo"      },
  amarillo: { bg: "#fef9c3", color: "#854d0e", dot: "#eab308", label: "Atención"       },
  rojo:     { bg: "#fee2e2", color: "#991b1b", dot: "#dc2626", label: "Crítico"        },
};

function calcSemaforo(v: Vehiculo, mantenimientos: Mantenimiento[]): { estado: SemaforoEstado; razon: string } {
  if (v.estado === "mantenimiento" || v.estado === "inactivo") return { estado: "rojo", razon: v.estado === "inactivo" ? "Inactivo" : "En taller" };
  if (v.estado_operativo === "no_apto") return { estado: "rojo", razon: "Doc. vencido" };
  const km = Number(v.kilometraje_actual || 0);
  const proxKm = Number(v.proximo_mantenimiento_km || 0);
  const kmRest = proxKm > 0 ? proxKm - km : null;
  const hoy = new Date();
  const mantVencido = mantenimientos.filter(m => m.vehiculo_id === v.id && m.proxima_fecha).some(m => new Date(m.proxima_fecha!) < hoy && m.estado !== "finalizado");
  if (mantVencido || (kmRest !== null && kmRest < 0)) return { estado: "rojo", razon: kmRest !== null && kmRest < 0 ? `KM vencido` : "Mant. vencido" };
  const proxAlerta = mantenimientos.filter(m => m.vehiculo_id === v.id && m.proxima_fecha).some(m => { const d = Math.ceil((new Date(m.proxima_fecha!).getTime() - hoy.getTime()) / 86400000); return d >= 0 && d <= 15; });
  if ((kmRest !== null && kmRest <= 1000) || proxAlerta) return { estado: "amarillo", razon: kmRest !== null ? `${kmRest.toLocaleString()} km` : "Serv. próximo" };
  return { estado: "verde", razon: kmRest !== null ? `${kmRest.toLocaleString()} km libres` : "Operativo" };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function estadoFecha(f: string | null): "vigente" | "por_vencer" | "vencido" | "sin_fecha" {
  const d = diasPara(f);
  if (d === null) return "sin_fecha";
  if (d < 0)    return "vencido";
  if (d <= 30)  return "por_vencer";
  return "vigente";
}
function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const ICONO_CAT: Record<string, string> = { AUTO: "🚗", SUV: "🚙", VAN: "🚐", MINIBUS: "🚌", BUS: "🚌", CUSTER: "🚐" };
const DOCS_OBLIGATORIOS = ["SOAT", "Revisión Técnica (CITV)", "Habilitación SUTRAN", "Permiso Operación MTC"];

// ─── SUBCOMPONENTES ───────────────────────────────────────────────────────────

function KpiCard({ label, valor, sub, color = "#0b315f", bg = "#eef3f8", icon, onClick }: {
  label: string; valor: string | number; sub?: string; color?: string; bg?: string; icon?: string; onClick?: () => void;
}) {
  return (
    <div className={`rounded-2xl p-4 border-2 transition-all space-y-1 ${onClick ? "cursor-pointer hover:shadow-md hover:scale-[1.01]" : ""}`}
      style={{ background: bg, borderColor: color + "33" }} onClick={onClick}>
      {icon && <div className="text-2xl mb-1">{icon}</div>}
      <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: color + "99" }}>{label}</p>
      <p className="text-2xl font-black leading-tight" style={{ color }}>{valor}</p>
      {sub && <p className="text-[11px]" style={{ color: color + "88" }}>{sub}</p>}
    </div>
  );
}

function DonutChart({ value, label, color }: { value: number; label: string; color: string }) {
  const r = 36; const circ = 2 * Math.PI * r;
  const offset = circ - Math.min(100, Math.max(0, value)) / 100 * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r={r} fill="none" stroke="#e5e7eb" strokeWidth="11" />
        <circle cx="45" cy="45" r={r} fill="none" stroke={color} strokeWidth="11"
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 45 45)" />
        <text x="45" y="41" textAnchor="middle" fontSize="13" fontWeight="800" fill={color}>{value}%</text>
        <text x="45" y="54" textAnchor="middle" fontSize="8" fill="#9ca3af">{label}</text>
      </svg>
    </div>
  );
}

function BarraColor({ label, valor, max, color }: { label: string; valor: number; max: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1"><span className="text-gray-500">{label}</span><span className="font-black text-gray-800">{valor}</span></div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${max ? Math.min(100, (valor / max) * 100) : 0}%`, background: color }} />
      </div>
    </div>
  );
}

type TipoAlerta = "critico" | "atencion" | "info" | "ok";
const ALERTA_CFG: Record<TipoAlerta, { bg: string; color: string; icon: string; label: string }> = {
  critico:  { bg: "#fee2e2", color: "#991b1b", icon: "🚨", label: "CRÍTICO" },
  atencion: { bg: "#fef9c3", color: "#854d0e", icon: "⚠️", label: "ATENCIÓN" },
  info:     { bg: "#dbeafe", color: "#1d4ed8", icon: "ℹ️", label: "INFO" },
  ok:       { bg: "#dcfce7", color: "#166534", icon: "✅", label: "OK" },
};

function AlertaItem({ tipo, texto, href, router }: { tipo: TipoAlerta; texto: string; href?: string; router: ReturnType<typeof useRouter>; }) {
  const cfg = ALERTA_CFG[tipo];
  return (
    <div className={`flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-xs font-medium transition-all ${href ? "cursor-pointer hover:brightness-95" : ""}`}
      style={{ background: cfg.bg, color: cfg.color }}
      onClick={href ? () => router.push(href) : undefined}>
      <span className="flex-shrink-0 mt-0.5">{cfg.icon}</span>
      <div className="flex-1 min-w-0">
        <span className="font-black mr-1">[{cfg.label}]</span>
        <span>{texto}</span>
      </div>
      {href && <span className="flex-shrink-0 font-bold opacity-60">→</span>}
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();

  const [reservas,      setReservas]      = useState<Reserva[]>([]);
  const [vehiculos,     setVehiculos]     = useState<Vehiculo[]>([]);
  const [conductores,   setConductores]   = useState<Conductor[]>([]);
  const [seguros,       setSeguros]       = useState<Seguro[]>([]);
  const [mantenimiento, setMantenimiento] = useState<Mantenimiento[]>([]);
  const [combustible,   setCombustible]   = useState<Combustible[]>([]);
  const [docsVehiculo,  setDocsVehiculo]  = useState<DocVehiculo[]>([]);
  const [neumaticos,    setNeumaticos]    = useState<Neumatico[]>([]);
  const [empresasTer,   setEmpresasTer]   = useState<EmpresaTer[]>([]);
  const [docsTercero,   setDocsTercero]   = useState<DocTercero[]>([]);
  const [facturas,      setFacturas]      = useState<Factura[]>([]);
  const [gastos,        setGastos]        = useState<Gasto[]>([]);
  const [loading,       setLoading]       = useState(true);

  useEffect(() => {
    (async () => {
      try {
      setLoading(true);
      // Wrapper para que ninguna query corte el dashboard si la tabla no existe
      // Supabase no lanza excepciones — devuelve { data, error }
      // safe() captura ambos casos sin cortar el dashboard
      const safe = async (q: Promise<{ data: any; error: any }>) => {
        const r = await q;
        if (r.error) { console.warn("Dashboard query:", r.error.message); return { data: [] }; }
        return r;
      };

      const [rRes, vRes, cRes, sRes, mRes, cbRes, dvRes, nRes, etRes, dtRes, fRes, gRes] = await Promise.all([
        safe(supabase.from("reservas").select("id,origen,destino,fecha_servicio,hora_servicio,tipo,estado,precio_cliente,costo_proveedor,margen,cliente_id,vehiculo_id,conductor_id,tipo_asignacion,empresa_tercerizada_id").order("id", { ascending: false })),
        safe(supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,kilometraje_actual,proximo_mantenimiento_km")),
        safe(supabase.from("conductores").select("id,nombre,estado,vencimiento_licencia")),
        safe(supabase.from("seguros").select("id,tipo,fecha_vencimiento,aseguradora,vehiculo_id")),
        safe(supabase.from("mantenimiento").select("id,costo,tipo,proxima_fecha,estado,vehiculo_id")),
        safe(supabase.from("combustible").select("id,total,fecha,vehiculo_id")),
        safe(supabase.from("documentos_vehiculo").select("id,vehiculo_id,tipo,fecha_vencimiento")),
        safe(supabase.from("neumaticos").select("id,vehiculo_id,km_actual,km_instalacion,vida_util_km,estado,cocada_actual,cocada_nueva,costo_compra")),
        safe(supabase.from("empresas_tercerizadas").select("id,razon_social,estado")),
        safe(supabase.from("documentos_tercero").select("id,empresa_id,tipo,fecha_vencimiento")),
        safe(supabase.from("facturas").select("id,total,estado,fecha_emision")),
        safe(supabase.from("gastos").select("id,monto,categoria,fecha")),
      ]);
      setReservas(rRes.data      || []);
      setVehiculos(vRes.data     || []);
      setConductores(cRes.data   || []);
      setSeguros(sRes.data       || []);
      setMantenimiento(mRes.data || []);
      setCombustible(cbRes.data  || []);
      setDocsVehiculo(dvRes.data || []);
      setNeumaticos(nRes.data    || []);
      setEmpresasTer(etRes.data  || []);
      setDocsTercero(dtRes.data  || []);
      setFacturas(fRes.data      || []);
      setGastos(gRes.data        || []);
      } catch (e) {
        console.error("Dashboard error:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Reservas ──────────────────────────────────────────────────────────────

  const hoy         = new Date().toISOString().split("T")[0];
  const resHoy      = reservas.filter(r => r.fecha_servicio === hoy);
  const pendientes  = reservas.filter(r => r.estado === "pendiente");
  const programadas = reservas.filter(r => r.estado === "programada");
  const confirmadas = reservas.filter(r => r.estado === "confirmada");
  const finalizadas = reservas.filter(r => r.estado === "finalizada");
  const canceladas  = reservas.filter(r => r.estado === "cancelada");
  const tercerizadas= reservas.filter(r => r.tipo === "tercerizada");
  const maxEstado   = Math.max(pendientes.length, confirmadas.length, finalizadas.length, canceladas.length, 1);

  // ── Financiero ────────────────────────────────────────────────────────────

  const totalVentas      = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const totalMargen      = reservas.reduce((s, r) => s + Number(r.margen || 0), 0);
  const totalFacturado   = facturas.reduce((s, f) => s + Number(f.total || 0), 0);
  const totalGastos      = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
  const gastoCombustible = combustible.reduce((s, c) => s + Number(c.total || 0), 0);
  const gastoManten      = mantenimiento.reduce((s, m) => s + Number(m.costo || 0), 0);
  const utilidad         = totalFacturado - totalGastos;
  const margenPct        = totalVentas > 0 ? Math.round((totalMargen / totalVentas) * 100) : 0;
  const avanceFact       = totalVentas > 0 ? Math.min(100, Math.round((totalFacturado / totalVentas) * 100)) : 0;

  // ── Semáforo flota ────────────────────────────────────────────────────────

  const datosFlota = vehiculos.map(v => ({
    vehiculo: v,
    semaforo: calcSemaforo(v, mantenimiento),
    costoMant: mantenimiento.filter(m => m.vehiculo_id === v.id).reduce((s, m) => s + Number(m.costo || 0), 0),
    costoComb: combustible.filter(c => c.vehiculo_id === v.id).reduce((s, c) => s + Number(c.total || 0), 0),
  }));

  const verdes    = datosFlota.filter(d => d.semaforo.estado === "verde").length;
  const amarillos = datosFlota.filter(d => d.semaforo.estado === "amarillo").length;
  const rojos     = datosFlota.filter(d => d.semaforo.estado === "rojo").length;
  const dispMecanica = vehiculos.length > 0 ? Math.round((verdes / vehiculos.length) * 100) : 0;

  const costoTotalFlota = datosFlota.reduce((s, d) => s + d.costoMant + d.costoComb, 0);
  const kmTotalFlota    = vehiculos.reduce((s, v) => s + Number(v.kilometraje_actual || 0), 0);
  const cpkFlota        = kmTotalFlota > 0 ? costoTotalFlota / kmTotalFlota : 0;

  // ── Conductores ───────────────────────────────────────────────────────────

  const condDisponibles = conductores.filter(c => c.estado === "disponible").length;
  const licVencidas     = conductores.filter(c => estadoFecha(c.vencimiento_licencia) === "vencido").length;
  const licPorVencer    = conductores.filter(c => estadoFecha(c.vencimiento_licencia) === "por_vencer").length;

  // ── Documentos vehiculares ────────────────────────────────────────────────

  const docsVencidos      = docsVehiculo.filter(d => estadoFecha(d.fecha_vencimiento) === "vencido").length;
  const docsPorVencer     = docsVehiculo.filter(d => estadoFecha(d.fecha_vencimiento) === "por_vencer").length;
  const docsOblVencidos   = docsVehiculo.filter(d => DOCS_OBLIGATORIOS.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "vencido").length;

  // Vehículos con docs vencidos (por placa)
  const vehConDocVencido  = new Set(docsVehiculo.filter(d => estadoFecha(d.fecha_vencimiento) === "vencido").map(d => d.vehiculo_id)).size;

  // ── Neumáticos ────────────────────────────────────────────────────────────

  const neuActivos    = neumaticos.filter(n => n.estado === "activo");
  const neuCriticos   = neuActivos.filter(n => {
    const km = Number(n.km_actual || 0) - Number(n.km_instalacion || 0);
    const vida = Number(n.vida_util_km || 80000);
    return vida > 0 && (km / vida) >= 0.9;
  }).length;
  const neuPorVencer  = neuActivos.filter(n => {
    const km = Number(n.km_actual || 0) - Number(n.km_instalacion || 0);
    const vida = Number(n.vida_util_km || 80000);
    const pct = vida > 0 ? km / vida : 0;
    return pct >= 0.7 && pct < 0.9;
  }).length;

  // CPK neumáticos
  const cpkNeu = neuActivos.filter(n => n.costo_compra && n.km_actual && n.km_instalacion).map(n => {
    const km = Number(n.km_actual) - Number(n.km_instalacion);
    return km > 0 ? Number(n.costo_compra) / km : null;
  }).filter(Boolean) as number[];
  const cpkNeuProm = cpkNeu.length > 0 ? cpkNeu.reduce((a, b) => a + b) / cpkNeu.length : null;

  // ── Seguros ───────────────────────────────────────────────────────────────

  const segurosVencidos  = seguros.filter(s => estadoFecha(s.fecha_vencimiento) === "vencido").length;
  const segurosPorVencer = seguros.filter(s => estadoFecha(s.fecha_vencimiento) === "por_vencer").length;
  const segurosObligVenc = seguros.filter(s => ["soat","cat","sctr_salud","sctr_pension","vida_ley"].includes(s.tipo) && estadoFecha(s.fecha_vencimiento) === "vencido").length;

  // ── Mantenimiento ─────────────────────────────────────────────────────────

  const mantPendiente = mantenimiento.filter(m => m.estado === "pendiente").length;
  const mantProximo   = mantenimiento.filter(m => { const d = diasPara(m.proxima_fecha); return d !== null && d >= 0 && d <= 15; }).length;

  // ── Tercerizadas ──────────────────────────────────────────────────────────

  const empresasConRiesgo = empresasTer.filter(e => {
    const docs = docsTercero.filter(d => d.empresa_id === e.id);
    return docs.some(d => DOCS_OBLIGATORIOS.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "vencido");
  }).length;
  const empresasPorVencer = empresasTer.filter(e => {
    const docs = docsTercero.filter(d => d.empresa_id === e.id);
    return !docs.some(d => DOCS_OBLIGATORIOS.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "vencido") &&
           docs.some(d => DOCS_OBLIGATORIOS.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "por_vencer");
  }).length;

  // ── Reservas con empresa tercerizada en riesgo ─────────────────────────────

  const resConTerRiesgo = reservas.filter(r =>
    r.empresa_tercerizada_id && empresasConRiesgo > 0 &&
    ["pendiente","programada","confirmada"].includes(r.estado)
  ).length;

  // ── ALERTAS UNIFICADAS ────────────────────────────────────────────────────

  type Alerta = { tipo: TipoAlerta; texto: string; href?: string; orden: number };
  const alertas: Alerta[] = [];

  // CRÍTICOS
  if (docsOblVencidos > 0)     alertas.push({ tipo: "critico",  texto: `${docsOblVencidos} doc. vehicular OBLIGATORIO vencido (SOAT, CITV, SUTRAN)`, href: "/documentos-vehiculares", orden: 1 });
  if (segurosObligVenc > 0)    alertas.push({ tipo: "critico",  texto: `${segurosObligVenc} seguro OBLIGATORIO vencido (SCTR, Vida Ley)`, href: "/seguros", orden: 2 });
  if (empresasConRiesgo > 0)   alertas.push({ tipo: "critico",  texto: `${empresasConRiesgo} empresa tercerizada con documentos vencidos`, href: "/tercerizadas", orden: 3 });
  if (licVencidas > 0)         alertas.push({ tipo: "critico",  texto: `${licVencidas} conductor(es) con licencia vencida — no pueden operar`, href: "/conductores", orden: 4 });
  if (neuCriticos > 0)         alertas.push({ tipo: "critico",  texto: `${neuCriticos} neumático(s) al 90%+ de vida útil — cambio inmediato`, href: "/neumaticos", orden: 5 });
  if (rojos > 0)               alertas.push({ tipo: "critico",  texto: `${rojos} vehículo(s) en estado CRÍTICO`, href: "/vehiculos", orden: 6 });

  // ATENCIÓN
  if (pendientes.length > 0)   alertas.push({ tipo: "atencion", texto: `${pendientes.length} reserva(s) pendiente(s) de programar`, href: "/reservas", orden: 10 });
  if (docsVencidos > 0)        alertas.push({ tipo: "atencion", texto: `${docsVencidos} documento(s) vencido en ${vehConDocVencido} vehículo(s)`, href: "/documentos-vehiculares", orden: 11 });
  if (segurosPorVencer > 0)    alertas.push({ tipo: "atencion", texto: `${segurosPorVencer} seguro(s) vence(n) en 30 días`, href: "/seguros", orden: 12 });
  if (licPorVencer > 0)        alertas.push({ tipo: "atencion", texto: `${licPorVencer} licencia(s) de conductor por vencer`, href: "/conductores", orden: 13 });
  if (mantPendiente > 0)       alertas.push({ tipo: "atencion", texto: `${mantPendiente} mantenimiento(s) pendiente(s)`, href: "/mantenimiento", orden: 14 });
  if (mantProximo > 0)         alertas.push({ tipo: "atencion", texto: `${mantProximo} mantenimiento(s) programado(s) en 15 días`, href: "/mantenimiento", orden: 15 });
  if (neuPorVencer > 0)        alertas.push({ tipo: "atencion", texto: `${neuPorVencer} neumático(s) entre 70-90% de vida útil`, href: "/neumaticos", orden: 16 });
  if (empresasPorVencer > 0)   alertas.push({ tipo: "atencion", texto: `${empresasPorVencer} empresa(s) tercerizada(s) con docs por vencer`, href: "/tercerizadas", orden: 17 });
  if (amarillos > 0)           alertas.push({ tipo: "atencion", texto: `${amarillos} vehículo(s) próximo(s) a mantenimiento`, href: "/vehiculos", orden: 18 });

  // INFO
  if (resHoy.length > 0)       alertas.push({ tipo: "info",     texto: `${resHoy.length} servicio(s) programado(s) para hoy`, href: "/reservas", orden: 20 });
  if (tercerizadas.length > 0) alertas.push({ tipo: "info",     texto: `${tercerizadas.length} reserva(s) tercerizada(s) en cartera`, href: "/reservas", orden: 21 });
  if (resConTerRiesgo > 0)     alertas.push({ tipo: "atencion", texto: `${resConTerRiesgo} reserva(s) activa(s) con empresa tercerizada en riesgo`, href: "/reservas", orden: 7 });

  if (alertas.length === 0)    alertas.push({ tipo: "ok", texto: "Operación estable · Sin alertas críticas detectadas", orden: 99 });

  alertas.sort((a, b) => a.orden - b.orden);
  const alertasCriticas = alertas.filter(a => a.tipo === "critico");
  const alertasAtencion = alertas.filter(a => a.tipo === "atencion");
  const alertasInfo     = alertas.filter(a => a.tipo === "info" || a.tipo === "ok");

  // ── Score de riesgo global (0-100, menor = mejor) ─────────────────────────

  const scoreRiesgo = Math.min(100,
    alertasCriticas.length * 20 + alertasAtencion.length * 5
  );
  const nivelRiesgo = scoreRiesgo === 0 ? "Bajo" : scoreRiesgo <= 20 ? "Moderado" : scoreRiesgo <= 50 ? "Alto" : "Crítico";
  const colorRiesgo = scoreRiesgo === 0 ? "#166534" : scoreRiesgo <= 20 ? "#854d0e" : scoreRiesgo <= 50 ? "#dc2626" : "#991b1b";
  const bgRiesgo    = scoreRiesgo === 0 ? "#dcfce7" : scoreRiesgo <= 20 ? "#fef9c3" : "#fee2e2";

  // ─── RENDER ───────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-4 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto" />
        <p className="text-sm font-bold text-[#0b315f]">Cargando dashboard...</p>
      </div>
    </div>
  );

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">
            {new Date().toLocaleDateString("es-PE", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            {resHoy.length > 0 && <span className="ml-2 font-bold text-[#0b315f]">· 🚌 {resHoy.length} servicio{resHoy.length > 1 ? "s" : ""} hoy</span>}
          </p>
        </div>
        {/* Score de riesgo */}
        <div className="flex items-center gap-3 rounded-2xl px-5 py-3 border-2" style={{ background: bgRiesgo, borderColor: colorRiesgo + "44" }}>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: colorRiesgo + "99" }}>Riesgo operativo</p>
            <p className="text-xl font-black" style={{ color: colorRiesgo }}>{nivelRiesgo}</p>
          </div>
          <div className="text-3xl">{scoreRiesgo === 0 ? "🟢" : scoreRiesgo <= 20 ? "🟡" : "🔴"}</div>
        </div>
      </div>

      {/* BANNER ALERTAS CRÍTICAS */}
      {alertasCriticas.length > 0 && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-red-800 mb-2">🚨 {alertasCriticas.length} Alerta{alertasCriticas.length > 1 ? "s" : ""} crítica{alertasCriticas.length > 1 ? "s" : ""} — acción inmediata requerida</p>
          {alertasCriticas.map((a, i) => <AlertaItem key={i} tipo={a.tipo} texto={a.texto} href={a.href} router={router} />)}
        </div>
      )}

      {/* FILA 1 — KPIs operativos principales */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon="🎫" label="Reservas" valor={reservas.length}
          sub={`${confirmadas.length} confirmadas · ${resHoy.length} hoy`}
          color="#0b315f" bg="#eef3f8" onClick={() => router.push("/reservas")} />
        <KpiCard icon="⏳" label="Pendientes" valor={pendientes.length}
          sub={`${programadas.length} programadas`}
          color={pendientes.length > 0 ? "#854d0e" : "#166534"}
          bg={pendientes.length > 0 ? "#fef9c3" : "#dcfce7"}
          onClick={() => router.push("/reservas")} />
        <KpiCard icon="🚌" label="Flota" valor={`${verdes}/${vehiculos.length}`}
          sub={`${dispMecanica}% disponibilidad · CPK S/ ${cpkFlota.toFixed(2)}`}
          color="#166534" bg="#dcfce7" onClick={() => router.push("/vehiculos")} />
        <KpiCard icon="🧑‍✈️" label="Conductores" valor={`${condDisponibles}/${conductores.length}`}
          sub={licVencidas > 0 ? `⚠ ${licVencidas} lic. vencida(s)` : "Todos habilitados"}
          color={licVencidas > 0 ? "#991b1b" : "#1d4ed8"}
          bg={licVencidas > 0 ? "#fee2e2" : "#dbeafe"}
          onClick={() => router.push("/conductores")} />
      </section>

      {/* FILA 2 — KPIs financieros */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon="💰" label="Ventas proyectadas" valor={fmtSoles(totalVentas)}
          sub={`Margen: ${margenPct}%`} color="#166534" bg="#dcfce7" />
        <KpiCard icon="🧾" label="Facturado" valor={fmtSoles(totalFacturado)}
          sub={`${avanceFact}% de ventas`} color="#1d4ed8" bg="#dbeafe"
          onClick={() => router.push("/facturacion")} />
        <KpiCard icon="💸" label="Gastos" valor={fmtSoles(totalGastos)}
          sub={`Comb: ${fmtSoles(gastoCombustible)} · Mant: ${fmtSoles(gastoManten)}`}
          color="#991b1b" bg="#fee2e2" onClick={() => router.push("/gastos")} />
        <KpiCard icon="📈" label="Utilidad estimada" valor={fmtSoles(utilidad)}
          sub={utilidad >= 0 ? "Positiva" : "Negativa"}
          color={utilidad >= 0 ? "#166534" : "#991b1b"}
          bg={utilidad >= 0 ? "#dcfce7" : "#fee2e2"} />
      </section>

      {/* FILA 3 — KPIs módulos nuevos */}
      <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard icon="📄" label="Docs. vehiculares" valor={docsVencidos > 0 ? `${docsVencidos} venc.` : "Al día"}
          sub={`${docsPorVencer} por vencer`}
          color={docsVencidos > 0 ? "#991b1b" : "#166534"}
          bg={docsVencidos > 0 ? "#fee2e2" : "#dcfce7"}
          onClick={() => router.push("/documentos-vehiculares")} />
        <KpiCard icon="🛞" label="Neumáticos" valor={neuCriticos > 0 ? `${neuCriticos} críticos` : "OK"}
          sub={`${neuPorVencer} por vencer · ${neuActivos.length} activos`}
          color={neuCriticos > 0 ? "#991b1b" : "#166534"}
          bg={neuCriticos > 0 ? "#fee2e2" : "#dcfce7"}
          onClick={() => router.push("/neumaticos")} />
        <KpiCard icon="⛽" label="Combustible" valor={fmtSoles(gastoCombustible)}
          sub={`${combustible.length} cargas`}
          color="#ea580c" bg="#fff7ed" onClick={() => router.push("/combustible")} />
        <KpiCard icon="🛡️" label="Seguros" valor={segurosVencidos > 0 ? `${segurosVencidos} venc.` : "Al día"}
          sub={`${segurosPorVencer} por vencer`}
          color={segurosVencidos > 0 ? "#991b1b" : "#166534"}
          bg={segurosVencidos > 0 ? "#fee2e2" : "#dcfce7"}
          onClick={() => router.push("/seguros")} />
        <KpiCard icon="🤝" label="Tercerizadas" valor={`${empresasTer.length} emp.`}
          sub={empresasConRiesgo > 0 ? `🚨 ${empresasConRiesgo} en riesgo` : "Docs al día"}
          color={empresasConRiesgo > 0 ? "#991b1b" : "#166534"}
          bg={empresasConRiesgo > 0 ? "#fee2e2" : "#dcfce7"}
          onClick={() => router.push("/tercerizadas")} />
        <KpiCard icon="🔧" label="Mantenimiento" valor={mantPendiente > 0 ? `${mantPendiente} pend.` : "Al día"}
          sub={`${mantProximo} en 15 días`}
          color={mantPendiente > 0 ? "#854d0e" : "#166534"}
          bg={mantPendiente > 0 ? "#fef9c3" : "#dcfce7"}
          onClick={() => router.push("/mantenimiento")} />
      </section>

      {/* FILA 4 — Gráficos + Semáforo + Alertas */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* Eficiencia operativa */}
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">Eficiencia operativa</h2>
          <div className="flex justify-around mb-4">
            <DonutChart value={dispMecanica}              label="Flota apta"  color="#0b315f" />
            <DonutChart value={avanceFact}                label="Facturación" color="#166534" />
            <DonutChart value={Math.max(0, margenPct)}    label="Margen"      color="#1d4ed8" />
          </div>
          {/* Reservas por estado */}
          <div className="space-y-2.5 pt-3 border-t" style={{ borderColor: "#f1f5f9" }}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Reservas por estado</p>
            <BarraColor label="Pendientes"  valor={pendientes.length}  max={maxEstado} color="#eab308" />
            <BarraColor label="Confirmadas" valor={confirmadas.length} max={maxEstado} color="#16a34a" />
            <BarraColor label="Finalizadas" valor={finalizadas.length} max={maxEstado} color="#2563eb" />
            <BarraColor label="Canceladas"  valor={canceladas.length}  max={maxEstado} color="#dc2626" />
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 mt-3 pt-3 border-t" style={{ borderColor: "#f1f5f9" }}>
            <span>🤝 Tercerizadas: <b className="text-gray-700">{tercerizadas.length}</b></span>
            <span>🚌 Hoy: <b className="text-gray-700">{resHoy.length}</b></span>
          </div>
        </div>

        {/* Semáforo de flota */}
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-gray-700">Semáforo de flota</h2>
            <button onClick={() => router.push("/vehiculos")} className="text-xs font-bold text-[#0b315f] hover:underline">Ver flota →</button>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {([
              { est: "verde"    as SemaforoEstado, valor: verdes,    icon: "🟢" },
              { est: "amarillo" as SemaforoEstado, valor: amarillos, icon: "🟡" },
              { est: "rojo"     as SemaforoEstado, valor: rojos,     icon: "🔴" },
            ]).map(s => {
              const cfg = SEMAFORO_CFG[s.est];
              return (
                <div key={s.est} className="rounded-xl p-3 text-center border" style={{ background: cfg.bg, borderColor: cfg.dot + "44" }}>
                  <div className="text-xl mb-0.5">{s.icon}</div>
                  <div className="text-2xl font-black" style={{ color: cfg.color }}>{s.valor}</div>
                  <div className="text-[10px] font-bold uppercase" style={{ color: cfg.color + "99" }}>{cfg.label}</div>
                </div>
              );
            })}
          </div>
          {/* Barra disponibilidad */}
          <div className="mb-4">
            <div className="flex justify-between text-xs mb-1">
              <span className="font-bold text-gray-600">Disponibilidad mecánica</span>
              <span className="font-black" style={{ color: dispMecanica >= 80 ? "#166534" : dispMecanica >= 60 ? "#854d0e" : "#991b1b" }}>{dispMecanica}%</span>
            </div>
            <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${dispMecanica}%`, background: dispMecanica >= 80 ? "#16a34a" : dispMecanica >= 60 ? "#eab308" : "#dc2626" }} />
            </div>
            <p className="text-[10px] text-gray-400 mt-1">Meta: 80% · CPK flota: <b style={{ color: cpkFlota > 5 ? "#dc2626" : "#166534" }}>S/ {cpkFlota.toFixed(3)}</b></p>
          </div>
          {/* Lista vehículos */}
          <div className="space-y-1.5">
            {datosFlota.slice(0, 5).map(d => {
              const cfg = SEMAFORO_CFG[d.semaforo.estado];
              const costoT = d.costoMant + d.costoComb;
              const km = Number(d.vehiculo.kilometraje_actual || 0);
              const cpk = km > 0 ? costoT / km : 0;
              return (
                <div key={d.vehiculo.id} className="flex items-center justify-between py-1.5 border-b last:border-0" style={{ borderColor: "#f8fafc" }}>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: cfg.dot }} />
                    <span>{ICONO_CAT[d.vehiculo.categoria || ""] || "🚌"}</span>
                    <div>
                      <span className="font-mono font-black text-sm text-gray-800">{d.vehiculo.placa}</span>
                      <span className="text-[10px] text-gray-400 ml-1">{d.vehiculo.categoria}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-bold" style={{ color: cfg.color }}>{d.semaforo.razon}</div>
                    {cpk > 0 && <div className="text-[10px] text-gray-400">CPK: <b style={{ color: cpk > 5 ? "#dc2626" : "#166534" }}>S/ {cpk.toFixed(3)}</b></div>}
                  </div>
                </div>
              );
            })}
            {vehiculos.length > 5 && <button onClick={() => router.push("/vehiculos")} className="w-full text-xs text-center text-[#0b315f] font-bold pt-1 hover:underline">+{vehiculos.length - 5} más →</button>}
            {vehiculos.length === 0 && <p className="text-sm text-gray-300 text-center py-3">Sin vehículos</p>}
          </div>
        </div>

        {/* Panel de alertas */}
        <div className="bg-white rounded-2xl border shadow-sm p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-gray-700">Centro de alertas</h2>
            <div className="flex gap-1.5">
              {alertasCriticas.length > 0 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">🚨 {alertasCriticas.length}</span>}
              {alertasAtencion.length > 0 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">⚠️ {alertasAtencion.length}</span>}
            </div>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto max-h-[380px]">
            {alertasCriticas.length > 0 && (
              <>
                <p className="text-[9px] font-black uppercase tracking-widest text-red-600">Críticos</p>
                {alertasCriticas.map((a, i) => <AlertaItem key={`c${i}`} tipo={a.tipo} texto={a.texto} href={a.href} router={router} />)}
              </>
            )}
            {alertasAtencion.length > 0 && (
              <>
                <p className="text-[9px] font-black uppercase tracking-widest text-amber-600 mt-2">Atención</p>
                {alertasAtencion.map((a, i) => <AlertaItem key={`a${i}`} tipo={a.tipo} texto={a.texto} href={a.href} router={router} />)}
              </>
            )}
            {alertasInfo.map((a, i) => <AlertaItem key={`i${i}`} tipo={a.tipo} texto={a.texto} href={a.href} router={router} />)}
          </div>
        </div>
      </section>

      {/* FILA 5 — Tercerizadas + Documentos + Costos */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* Empresas tercerizadas */}
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-gray-700">🤝 Empresas tercerizadas</h2>
            <button onClick={() => router.push("/tercerizadas")} className="text-xs font-bold text-[#0b315f] hover:underline">Gestionar →</button>
          </div>
          {empresasTer.length === 0 ? (
            <p className="text-sm text-gray-300 text-center py-4">Sin empresas registradas</p>
          ) : (
            <div className="space-y-2">
              {empresasTer.slice(0, 6).map(e => {
                const docs = docsTercero.filter(d => d.empresa_id === e.id);
                const tieneVencido = docs.some(d => DOCS_OBLIGATORIOS.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "vencido");
                const tienePorVencer = !tieneVencido && docs.some(d => DOCS_OBLIGATORIOS.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "por_vencer");
                const color = tieneVencido ? "#dc2626" : tienePorVencer ? "#eab308" : "#16a34a";
                const icon  = tieneVencido ? "🚨" : tienePorVencer ? "⚠️" : "✅";
                return (
                  <div key={e.id} className="flex items-center justify-between rounded-xl px-3 py-2.5 border cursor-pointer hover:bg-gray-50"
                    style={{ borderColor: tieneVencido ? "#fca5a5" : tienePorVencer ? "#fde68a" : "#e5e7eb" }}
                    onClick={() => router.push("/tercerizadas")}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span>{icon}</span>
                      <span className="font-bold text-xs text-gray-800 truncate">{e.razon_social}</span>
                    </div>
                    <div className="text-[10px] font-bold flex-shrink-0 ml-2" style={{ color }}>
                      {tieneVencido ? "Doc. vencido" : tienePorVencer ? "Por vencer" : "OK"}
                    </div>
                  </div>
                );
              })}
              {empresasTer.length > 6 && <p className="text-xs text-center text-gray-400">+{empresasTer.length - 6} empresas más</p>}
            </div>
          )}
          {/* CPK Neumáticos al pie */}
          {cpkNeuProm !== null && (
            <div className="mt-4 pt-3 border-t flex justify-between text-xs" style={{ borderColor: "#f1f5f9" }}>
              <span className="text-gray-500">🛞 CPK neumáticos prom.</span>
              <b style={{ color: cpkNeuProm > 3 ? "#dc2626" : "#166634" }}>S/ {cpkNeuProm.toFixed(3)}/km</b>
            </div>
          )}
        </div>

        {/* Documentos vehiculares próximos */}
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-gray-700">📄 Docs. por vencer (30d)</h2>
            <button onClick={() => router.push("/documentos-vehiculares")} className="text-xs font-bold text-[#0b315f] hover:underline">Ver todos →</button>
          </div>
          {(() => {
            const proxDocs = docsVehiculo
              .filter(d => { const dias = diasPara(d.fecha_vencimiento); return dias !== null && dias >= 0 && dias <= 30; })
              .sort((a, b) => (diasPara(a.fecha_vencimiento) || 0) - (diasPara(b.fecha_vencimiento) || 0))
              .slice(0, 6);
            const docVenc = docsVehiculo.filter(d => estadoFecha(d.fecha_vencimiento) === "vencido").slice(0, 3);

            if (proxDocs.length === 0 && docVenc.length === 0) return <p className="text-sm text-gray-300 text-center py-4">Sin vencimientos próximos</p>;

            return (
              <div className="space-y-2">
                {docVenc.map(d => {
                  const veh = vehiculos.find(v => v.id === d.vehiculo_id);
                  const dias = diasPara(d.fecha_vencimiento);
                  return (
                    <div key={d.id} className="flex items-center justify-between rounded-xl px-3 py-2 bg-red-50 border border-red-100">
                      <div className="text-xs">
                        <span className="font-black text-[#0b315f] font-mono">{veh?.placa || "—"}</span>
                        <span className="text-gray-600 ml-2">{d.tipo}</span>
                      </div>
                      <span className="text-xs font-black text-red-700">{Math.abs(dias || 0)}d venc.</span>
                    </div>
                  );
                })}
                {proxDocs.map(d => {
                  const veh  = vehiculos.find(v => v.id === d.vehiculo_id);
                  const dias = diasPara(d.fecha_vencimiento) || 0;
                  const urg  = dias <= 7;
                  return (
                    <div key={d.id} className="flex items-center justify-between rounded-xl px-3 py-2"
                      style={{ background: urg ? "#fef9c3" : "#f8fafc" }}>
                      <div className="text-xs">
                        <span className="font-black text-[#0b315f] font-mono">{veh?.placa || "—"}</span>
                        <span className="text-gray-600 ml-2">{d.tipo}</span>
                      </div>
                      <span className="text-xs font-black" style={{ color: urg ? "#854d0e" : "#0b315f" }}>{dias}d</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Desglose costos */}
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">💸 Desglose de costos</h2>
          <div className="space-y-3">
            {[
              { label: "⛽ Combustible",   valor: gastoCombustible, color: "#ef4444", href: "/combustible" },
              { label: "🔧 Mantenimiento", valor: gastoManten,      color: "#f97316", href: "/mantenimiento" },
              { label: "💸 Gastos gral.",  valor: totalGastos,      color: "#eab308", href: "/gastos" },
            ].map(({ label, valor, color, href }) => (
              <div key={label} className="flex items-center justify-between py-2 border-b last:border-0 cursor-pointer hover:bg-gray-50 rounded-lg px-2 -mx-2"
                style={{ borderColor: "#f1f5f9" }} onClick={() => router.push(href)}>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                  <span className="text-sm text-gray-600">{label}</span>
                </div>
                <span className="font-bold text-sm text-gray-800">{fmtSoles(valor)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: "#e5e7eb" }}>
              <span className="text-sm font-bold text-gray-700">Margen total reservas</span>
              <span className="font-black text-sm" style={{ color: totalMargen >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(totalMargen)}</span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: "#f1f5f9" }}>
              <div>
                <span className="text-sm font-bold text-gray-700">CPK flota</span>
                <span className="text-[10px] text-gray-400 ml-1">costo/km</span>
              </div>
              <span className="font-black text-sm" style={{ color: cpkFlota > 5 ? "#dc2626" : cpkFlota > 2 ? "#eab308" : "#166534" }}>
                {cpkFlota > 0 ? `S/ ${cpkFlota.toFixed(3)}` : "—"}
              </span>
            </div>
            {cpkNeuProm && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-gray-700">CPK neumáticos</span>
                <span className="font-black text-sm" style={{ color: cpkNeuProm > 3 ? "#dc2626" : "#166534" }}>
                  S/ {cpkNeuProm.toFixed(3)}
                </span>
              </div>
            )}
            {/* Utilidad */}
            <div className="rounded-xl p-3 mt-2" style={{ background: utilidad >= 0 ? "#dcfce7" : "#fee2e2" }}>
              <div className="flex justify-between">
                <span className="text-sm font-bold" style={{ color: utilidad >= 0 ? "#166534" : "#991b1b" }}>Utilidad estimada</span>
                <span className="font-black text-lg" style={{ color: utilidad >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(utilidad)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FILA 6 — Últimas reservas */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: "#f1f5f9" }}>
          <h2 className="text-sm font-bold text-gray-700">Últimas 8 reservas</h2>
          <button onClick={() => router.push("/reservas")} className="text-xs font-bold text-[#0b315f] hover:underline">Ver todas →</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["ID", "Ruta", "Fecha", "Asignación", "Estado", "Precio", "Margen"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reservas.slice(0, 8).map(r => {
                const estCfg: Record<string, { label: string; bg: string; color: string }> = {
                  pendiente:  { label: "Pendiente",  bg: "#fef9c3", color: "#854d0e" },
                  programada: { label: "Programada", bg: "#e0f2fe", color: "#0369a1" },
                  confirmada: { label: "Confirmada", bg: "#dcfce7", color: "#166534" },
                  en_curso:   { label: "En curso",   bg: "#dbeafe", color: "#1d4ed8" },
                  finalizada: { label: "Finalizada", bg: "#ede9fe", color: "#6d28d9" },
                  cancelada:  { label: "Cancelada",  bg: "#fee2e2", color: "#991b1b" },
                };
                const est = estCfg[r.estado] || estCfg.pendiente;
                const margen = Number(r.margen || 0);
                const esTer  = r.tipo === "tercerizada";
                const empTer = esTer && r.empresa_tercerizada_id ? empresasTer.find(e => e.id === r.empresa_tercerizada_id) : null;
                const riesgoTer = empTer ? docsTercero.filter(d => d.empresa_id === empTer.id).some(d => DOCS_OBLIGATORIOS.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "vencido") : false;
                return (
                  <tr key={r.id} className="border-t hover:bg-gray-50 cursor-pointer transition-colors"
                    style={{ borderColor: "#f1f5f9" }} onClick={() => router.push("/reservas")}>
                    <td className="p-3">
                      <span className="font-black font-mono text-[#0b315f]">#{r.id}</span>
                      {r.fecha_servicio === hoy && <div className="text-[9px] font-bold text-orange-500">HOY</div>}
                      {riesgoTer && <div className="text-[9px] font-bold text-red-600">🚨</div>}
                    </td>
                    <td className="p-3 text-gray-700 max-w-[180px]">
                      <div className="truncate text-xs">{r.origen} → {r.destino}</div>
                    </td>
                    <td className="p-3 text-gray-500 text-xs">{fmtFecha(r.fecha_servicio)}</td>
                    <td className="p-3">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                        style={esTer ? { background: "#ede9fe", color: "#6d28d9" } : { background: "#e0f2fe", color: "#0369a1" }}>
                        {esTer ? "🤝 Ter." : "🚌 Prop."}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="text-xs font-bold px-2.5 py-1 rounded-lg"
                        style={{ background: est.bg, color: est.color }}>{est.label}</span>
                    </td>
                    <td className="p-3 font-bold text-gray-800 text-xs">{fmtSoles(Number(r.precio_cliente || 0))}</td>
                    <td className="p-3 font-bold text-xs" style={{ color: margen >= 0 ? "#166534" : "#991b1b" }}>
                      {fmtSoles(margen)}
                    </td>
                  </tr>
                );
              })}
              {reservas.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-gray-400">
                  <p className="text-2xl mb-1">📋</p><p>No hay reservas registradas</p>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {reservas.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>Últimas 8 de {reservas.length} reservas</span>
            <span>AFA ERP · Dashboard</span>
          </div>
        )}
      </section>
    </main>
  );
}