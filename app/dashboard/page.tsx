"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Reserva = {
  id: number; origen: string; destino: string;
  fecha_servicio: string | null; hora_servicio: string | null;
  tipo: string; estado: string;
  precio_cliente: number; costo_proveedor: number; margen: number;
  cliente_id: number | null; vehiculo_id: number | null; conductor_id: number | null;
};
type Vehiculo = {
  id: number; placa: string; categoria: string | null;
  estado: string | null; estado_operativo: string | null;
  kilometraje_actual: number | null;
  proximo_mantenimiento_km: number | null;
};
type Conductor     = { id: number; nombre: string; estado: string | null; vencimiento_licencia: string | null; };
type Factura       = { id: number; total: number; estado: string; fecha_emision: string | null; };
type Gasto         = { id: number; monto: number; categoria: string | null; fecha: string | null; };
type Seguro        = { id: number; tipo: string; fecha_vencimiento: string | null; aseguradora: string | null; vehiculo_id: number | null; };
type Mantenimiento = { id: number; costo: number; tipo: string | null; proxima_fecha: string | null; estado: string | null; vehiculo_id: number | null; };
type Combustible   = { id: number; total: number; fecha: string | null; vehiculo_id: number | null; };
type Cliente       = { id: number; nombre: string; estado: string; tipo: string | null; };

// ─── SEMÁFORO ─────────────────────────────────────────────────────────────────

type SemaforoEstado = "verde" | "amarillo" | "rojo";

const SEMAFORO_CFG = {
  verde:    { bg: "#dcfce7", color: "#166534", dot: "#16a34a", label: "Operativo"      },
  amarillo: { bg: "#fef9c3", color: "#854d0e", dot: "#eab308", label: "Próx. servicio" },
  rojo:     { bg: "#fee2e2", color: "#991b1b", dot: "#dc2626", label: "Crítico"        },
};

function calcSemaforo(
  v: Vehiculo,
  mantenimientos: Mantenimiento[],
): { estado: SemaforoEstado; razon: string; kmRestantes: number | null } {
  if (v.estado === "mantenimiento") return { estado: "rojo",    razon: "En taller",          kmRestantes: null };
  if (v.estado === "inactivo")      return { estado: "rojo",    razon: "Inactivo",            kmRestantes: null };
  if (v.estado_operativo === "no_apto") return { estado: "rojo", razon: "No apto",           kmRestantes: null };

  const km     = Number(v.kilometraje_actual || 0);
  const proxKm = Number(v.proximo_mantenimiento_km || 0);
  const kmRest = proxKm > 0 ? proxKm - km : null;

  const hoy = new Date();
  const mantVencido = mantenimientos
    .filter(m => m.vehiculo_id === v.id && m.proxima_fecha)
    .some(m => new Date(m.proxima_fecha!) < hoy && m.estado !== "finalizado" && m.estado !== "cancelado");

  if (mantVencido || (kmRest !== null && kmRest < 0))
    return { estado: "rojo", razon: kmRest !== null && kmRest < 0 ? `Vencido ${Math.abs(kmRest).toLocaleString()} km` : "Mant. vencido", kmRestantes: kmRest };

  const proxFechaAlerta = mantenimientos
    .filter(m => m.vehiculo_id === v.id && m.proxima_fecha)
    .some(m => {
      const d = Math.ceil((new Date(m.proxima_fecha!).getTime() - hoy.getTime()) / 86400000);
      return d >= 0 && d <= 15;
    });

  if ((kmRest !== null && kmRest <= 1000) || proxFechaAlerta)
    return { estado: "amarillo", razon: kmRest !== null && kmRest <= 1000 ? `${kmRest.toLocaleString()} km para serv.` : "Serv. en 15 días", kmRestantes: kmRest };

  return { estado: "verde", razon: kmRest !== null ? `${kmRest.toLocaleString()} km libres` : "Operativo", kmRestantes: kmRest };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasPara(fecha: string | null): number | null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha).getTime() - Date.now()) / 86400000);
}

function estadoFecha(fecha: string | null) {
  const d = diasPara(fecha);
  if (d === null) return "sin_fecha";
  if (d < 0)   return "vencido";
  if (d <= 30) return "por_vencer";
  return "vigente";
}

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f).toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric" });
}

const ESTADO_RESERVA: Record<string, { label: string; bg: string; color: string }> = {
  pendiente:  { label: "Pendiente",  bg: "#fef9c3", color: "#854d0e" },
  confirmada: { label: "Confirmada", bg: "#dcfce7", color: "#166534" },
  finalizada: { label: "Finalizada", bg: "#dbeafe", color: "#1d4ed8" },
  cancelada:  { label: "Cancelada",  bg: "#fee2e2", color: "#991b1b" },
};

const ICONO_CAT: Record<string, string> = {
  AUTO: "🚗", SUV: "🚙", VAN: "🚐", MINIBUS: "🚌", BUS: "🚌",
};

// ─── SUBCOMPONENTES ───────────────────────────────────────────────────────────

function KpiCard({ label, valor, sub, color = "#0b315f", bg = "#eef3f8", onClick }:
  { label: string; valor: string | number; sub?: string; color?: string; bg?: string; onClick?: () => void }) {
  return (
    <div className={`rounded-xl p-4 border transition-all ${onClick ? "cursor-pointer hover:shadow-md" : ""}`}
      style={{ background: bg, borderColor: color + "22" }} onClick={onClick}>
      <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: color + "99" }}>{label}</p>
      <p className="text-2xl font-black mt-0.5" style={{ color }}>{valor}</p>
      {sub && <p className="text-[11px] mt-1" style={{ color: color + "88" }}>{sub}</p>}
    </div>
  );
}

function DonutChart({ value, label, color }: { value: number; label: string; color: string }) {
  const r = 38; const circ = 2 * Math.PI * r;
  const offset = circ - Math.min(100, Math.max(0, value)) / 100 * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="12"
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 50 50)" />
        <text x="50" y="46" textAnchor="middle" fontSize="14" fontWeight="700" fill={color}>{value}%</text>
        <text x="50" y="60" textAnchor="middle" fontSize="9" fill="#9ca3af">{label}</text>
      </svg>
    </div>
  );
}

function BarraEstado({ label, valor, max, color }: { label: string; valor: number; max: number; color: string }) {
  const w = max ? Math.min(100, (valor / max) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-600">{label}</span>
        <span className="font-bold text-gray-800">{valor}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${w}%`, background: color }} />
      </div>
    </div>
  );
}

function AlertaBadge({ tipo, texto, href, onClick }: { tipo: "error" | "warn" | "ok" | "info"; texto: string; href?: string; onClick?: () => void }) {
  const cfg = {
    error: { bg: "#fee2e2", color: "#991b1b", icon: "🔴" },
    warn:  { bg: "#fef9c3", color: "#854d0e", icon: "🟡" },
    ok:    { bg: "#dcfce7", color: "#166534", icon: "🟢" },
    info:  { bg: "#dbeafe", color: "#1d4ed8", icon: "🔵" },
  }[tipo];
  return (
    <div className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs font-medium ${onClick ? "cursor-pointer" : ""}`}
      style={{ background: cfg.bg, color: cfg.color }} onClick={onClick}>
      <span>{cfg.icon}</span>
      <span className="flex-1">{texto}</span>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();

  const [reservas,      setReservas]      = useState<Reserva[]>([]);
  const [vehiculos,     setVehiculos]     = useState<Vehiculo[]>([]);
  const [conductores,   setConductores]   = useState<Conductor[]>([]);
  const [facturas,      setFacturas]      = useState<Factura[]>([]);
  const [gastos,        setGastos]        = useState<Gasto[]>([]);
  const [seguros,       setSeguros]       = useState<Seguro[]>([]);
  const [mantenimiento, setMantenimiento] = useState<Mantenimiento[]>([]);
  const [combustible,   setCombustible]   = useState<Combustible[]>([]);
  const [clientes,      setClientes]      = useState<Cliente[]>([]);
  const [loading,       setLoading]       = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [rRes, vRes, cRes, fRes, gRes, sRes, mRes, cbRes, clRes] = await Promise.all([
        supabase.from("reservas").select("*").order("id", { ascending: false }),
        supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,kilometraje_actual,proximo_mantenimiento_km"),
        supabase.from("conductores").select("id,nombre,estado,vencimiento_licencia"),
        supabase.from("facturas").select("id,total,estado,fecha_emision"),
        supabase.from("gastos").select("id,monto,categoria,fecha"),
        supabase.from("seguros").select("id,tipo,fecha_vencimiento,aseguradora,vehiculo_id"),
        supabase.from("mantenimiento").select("id,costo,tipo,proxima_fecha,estado,vehiculo_id"),
        supabase.from("combustible").select("id,total,fecha,vehiculo_id"),
        supabase.from("clientes").select("id,nombre,estado,tipo"),
      ]);
      setReservas(rRes.data      || []);
      setVehiculos(vRes.data     || []);
      setConductores(cRes.data   || []);
      setFacturas(fRes.data      || []);
      setGastos(gRes.data        || []);
      setSeguros(sRes.data       || []);
      setMantenimiento(mRes.data || []);
      setCombustible(cbRes.data  || []);
      setClientes(clRes.data     || []);
      setLoading(false);
    })();
  }, []);

  // ── Métricas reservas ─────────────────────────────────────────────────────

  const hoy             = new Date().toISOString().split("T")[0];
  const reservasHoy     = reservas.filter(r => r.fecha_servicio === hoy);
  const pendientes      = reservas.filter(r => r.estado === "pendiente");
  const confirmadas     = reservas.filter(r => r.estado === "confirmada");
  const finalizadas     = reservas.filter(r => r.estado === "finalizada");
  const canceladas      = reservas.filter(r => r.estado === "cancelada");
  const tercerizadas    = reservas.filter(r => r.tipo === "tercerizada");
  const maxEstado       = Math.max(pendientes.length, confirmadas.length, finalizadas.length, canceladas.length, 1);

  // ── Financiero ────────────────────────────────────────────────────────────

  const totalVentas       = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const totalMargen       = reservas.reduce((s, r) => s + Number(r.margen || 0), 0);
  const totalFacturado    = facturas.reduce((s, f) => s + Number(f.total || 0), 0);
  const totalGastos       = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
  const gastoCombustible  = combustible.reduce((s, c) => s + Number(c.total || 0), 0);
  const gastoManten       = mantenimiento.reduce((s, m) => s + Number(m.costo || 0), 0);
  const utilidad          = totalFacturado - totalGastos;
  const margenPct         = totalVentas > 0 ? Math.round((totalMargen / totalVentas) * 100) : 0;
  const avanceFacturacion = totalVentas > 0 ? Math.min(100, Math.round((totalFacturado / totalVentas) * 100)) : 0;

  // ── Semáforo de flota ─────────────────────────────────────────────────────

  const datosFlota = vehiculos.map(v => ({
    vehiculo: v,
    semaforo: calcSemaforo(v, mantenimiento),
    costoMant: mantenimiento.filter(m => m.vehiculo_id === v.id).reduce((s, m) => s + Number(m.costo || 0), 0),
    costoComb: combustible.filter(c => c.vehiculo_id === v.id).reduce((s, c) => s + Number(c.total || 0), 0),
  }));

  const verdes    = datosFlota.filter(d => d.semaforo.estado === "verde").length;
  const amarillos = datosFlota.filter(d => d.semaforo.estado === "amarillo").length;
  const rojos     = datosFlota.filter(d => d.semaforo.estado === "rojo").length;

  const disponibilidadMecanica = vehiculos.length > 0 ? Math.round((verdes / vehiculos.length) * 100) : 0;

  // CPK flota
  const costoTotalFlota = datosFlota.reduce((s, d) => s + d.costoMant + d.costoComb, 0);
  const kmTotalFlota    = vehiculos.reduce((s, v) => s + Number(v.kilometraje_actual || 0), 0);
  const cpkFlota        = kmTotalFlota > 0 ? costoTotalFlota / kmTotalFlota : 0;

  // ── Conductores ───────────────────────────────────────────────────────────

  const aptos           = vehiculos.filter(v => v.estado_operativo === "apto").length;
  const disponibles     = vehiculos.filter(v => v.estado === "disponible").length;
  const eficienciaFlota = vehiculos.length ? Math.round((aptos / vehiculos.length) * 100) : 0;
  const condDisponibles = conductores.filter(c => c.estado === "disponible").length;
  const licVencidas     = conductores.filter(c => estadoFecha(c.vencimiento_licencia) === "vencido").length;
  const licPorVencer    = conductores.filter(c => estadoFecha(c.vencimiento_licencia) === "por_vencer").length;

  // ── Seguros + mantenimiento ───────────────────────────────────────────────

  const segurosVencidos  = seguros.filter(s => estadoFecha(s.fecha_vencimiento) === "vencido").length;
  const segurosPorVencer = seguros.filter(s => estadoFecha(s.fecha_vencimiento) === "por_vencer").length;
  const mantenPendiente  = mantenimiento.filter(m => m.estado === "pendiente").length;
  const mantenProximo    = mantenimiento.filter(m => { const d = diasPara(m.proxima_fecha); return d !== null && d >= 0 && d <= 15; }).length;
  const clientesBloqueados = clientes.filter(c => c.estado === "bloqueado").length;

  // ── Alertas ───────────────────────────────────────────────────────────────

  type Alerta = { tipo: "error" | "warn" | "info" | "ok"; texto: string; href?: string };
  const alertas: Alerta[] = [];
  if (rojos > 0)             alertas.push({ tipo: "error", texto: `${rojos} vehículo${rojos > 1 ? "s" : ""} en estado crítico 🔴`, href: "/vehiculos" });
  if (pendientes.length > 0) alertas.push({ tipo: "info",  texto: `${pendientes.length} reserva(s) pendiente(s) de programar`, href: "/reservas" });
  if (segurosVencidos > 0)   alertas.push({ tipo: "error", texto: `${segurosVencidos} seguro(s) vencido(s)`, href: "/seguros" });
  if (segurosPorVencer > 0)  alertas.push({ tipo: "warn",  texto: `${segurosPorVencer} seguro(s) vence(n) en 30 días`, href: "/seguros" });
  if (licVencidas > 0)       alertas.push({ tipo: "error", texto: `${licVencidas} licencia(s) de conductor vencida(s)`, href: "/conductores" });
  if (licPorVencer > 0)      alertas.push({ tipo: "warn",  texto: `${licPorVencer} licencia(s) por vencer`, href: "/conductores" });
  if (mantenPendiente > 0)   alertas.push({ tipo: "warn",  texto: `${mantenPendiente} mantenimiento(s) pendiente(s)`, href: "/mantenimiento" });
  if (mantenProximo > 0)     alertas.push({ tipo: "warn",  texto: `${mantenProximo} mantenimiento(s) en 15 días`, href: "/mantenimiento" });
  if (amarillos > 0)         alertas.push({ tipo: "warn",  texto: `${amarillos} vehículo${amarillos > 1 ? "s" : ""} próximo${amarillos > 1 ? "s" : ""} a mantenimiento 🟡`, href: "/vehiculos" });
  if (clientesBloqueados > 0) alertas.push({ tipo: "warn", texto: `${clientesBloqueados} cliente(s) bloqueado(s)`, href: "/clientes" });
  if (alertas.length === 0)  alertas.push({ tipo: "ok",    texto: "Operación estable · Sin alertas críticas" });

  // ─── RENDER ───────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-4 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto" />
        <p className="text-sm font-bold text-gray-500">Cargando dashboard...</p>
      </div>
    </div>
  );

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">
            {new Date().toLocaleDateString("es-PE", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            {reservasHoy.length > 0 && ` · ${reservasHoy.length} servicio(s) hoy`}
          </p>
        </div>
        {reservasHoy.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold"
            style={{ background: "#eef3f8", color: "#0b315f" }}>
            🚌 {reservasHoy.length} servicio{reservasHoy.length > 1 ? "s" : ""} hoy
          </div>
        )}
      </div>

      {/* FILA 1 — KPIs operativos */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Reservas totales" valor={reservas.length}
          sub={`${confirmadas.length} confirmadas`} color="#0b315f" bg="#eef3f8"
          onClick={() => router.push("/reservas")} />
        <KpiCard label="Pendientes" valor={pendientes.length} sub="Por programar"
          color={pendientes.length > 0 ? "#854d0e" : "#166534"}
          bg={pendientes.length > 0 ? "#fef9c3" : "#dcfce7"}
          onClick={() => router.push("/reservas")} />
        <KpiCard label="Flota disponible" valor={`${disponibles}/${vehiculos.length}`}
          sub={`${aptos} aptos · ${eficienciaFlota}% eficiencia`}
          color="#166534" bg="#dcfce7" onClick={() => router.push("/vehiculos")} />
        <KpiCard label="Conductores" valor={`${condDisponibles}/${conductores.length}`}
          sub="Disponibles" color="#1d4ed8" bg="#dbeafe"
          onClick={() => router.push("/conductores")} />
      </section>

      {/* FILA 2 — KPIs financieros */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Ventas proyectadas" valor={fmtSoles(totalVentas)}
          sub={`${tercerizadas.length} tercerizadas`} color="#166534" bg="#dcfce7" />
        <KpiCard label="Facturado" valor={fmtSoles(totalFacturado)}
          sub={`${avanceFacturacion}% de ventas`} color="#1d4ed8" bg="#dbeafe"
          onClick={() => router.push("/facturacion")} />
        <KpiCard label="Gastos totales" valor={fmtSoles(totalGastos)}
          sub={`Comb: ${fmtSoles(gastoCombustible)}`} color="#991b1b" bg="#fee2e2"
          onClick={() => router.push("/gastos")} />
        <KpiCard label="Utilidad estimada" valor={fmtSoles(utilidad)}
          sub={`Margen: ${margenPct}%`}
          color={utilidad >= 0 ? "#166534" : "#991b1b"}
          bg={utilidad >= 0 ? "#dcfce7" : "#fee2e2"} />
      </section>

      {/* FILA 3 — Gráficos + Alertas */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">Eficiencia operativa</h2>
          <div className="flex justify-around">
            <DonutChart value={eficienciaFlota}        label="Flota apta"   color="#0b315f" />
            <DonutChart value={avanceFacturacion}      label="Facturación"  color="#166534" />
            <DonutChart value={Math.max(0, margenPct)} label="Margen"       color="#1d4ed8" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">Reservas por estado</h2>
          <div className="space-y-3">
            <BarraEstado label="Pendientes"  valor={pendientes.length}  max={maxEstado} color="#eab308" />
            <BarraEstado label="Confirmadas" valor={confirmadas.length} max={maxEstado} color="#16a34a" />
            <BarraEstado label="Finalizadas" valor={finalizadas.length} max={maxEstado} color="#2563eb" />
            <BarraEstado label="Canceladas"  valor={canceladas.length}  max={maxEstado} color="#dc2626" />
          </div>
          <div className="mt-4 pt-3 border-t grid grid-cols-2 gap-2 text-xs text-gray-500">
            <span>Tercerizadas: <b className="text-gray-700">{tercerizadas.length}</b></span>
            <span>Hoy: <b className="text-gray-700">{reservasHoy.length}</b></span>
          </div>
        </div>

        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-3">Alertas y acciones</h2>
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {alertas.map((a, i) => (
              <AlertaBadge key={i} tipo={a.tipo} texto={a.texto}
                onClick={a.href ? () => router.push(a.href!) : undefined} />
            ))}
          </div>
        </div>
      </section>

      {/* FILA 4 — Costos + Semáforo de flota */}
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Desglose costos */}
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">Desglose de costos</h2>
          <div className="space-y-3">
            {[
              { label: "Combustible",      valor: gastoCombustible, color: "#ef4444" },
              { label: "Mantenimiento",    valor: gastoManten,      color: "#f97316" },
              { label: "Gastos generales", valor: totalGastos,      color: "#eab308" },
            ].map(({ label, valor, color }) => (
              <div key={label} className="flex items-center justify-between py-2 border-b last:border-0"
                style={{ borderColor: "#f1f5f9" }}>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                  <span className="text-sm text-gray-600">{label}</span>
                </div>
                <span className="font-bold text-sm text-gray-800">{fmtSoles(valor)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm font-bold text-gray-700">Margen total reservas</span>
              <span className="font-black text-sm" style={{ color: totalMargen >= 0 ? "#166534" : "#991b1b" }}>
                {fmtSoles(totalMargen)}
              </span>
            </div>
            {/* CPK */}
            <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: "#f1f5f9" }}>
              <div>
                <span className="text-sm font-bold text-gray-700">CPK flota</span>
                <span className="text-[10px] text-gray-400 ml-1">(costo por km)</span>
              </div>
              <span className="font-black text-sm"
                style={{ color: cpkFlota > 5 ? "#dc2626" : cpkFlota > 2 ? "#eab308" : "#166534" }}>
                {cpkFlota > 0 ? `S/ ${cpkFlota.toFixed(3)}` : "—"}
              </span>
            </div>
          </div>
        </div>

        {/* ── SEMÁFORO DE FLOTA (reemplaza "Estado de flota") ── */}
        <div className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-gray-700">Semáforo de flota</h2>
            <button onClick={() => router.push("/vehiculos")}
              className="text-xs font-bold text-[#0b315f] hover:underline">Ver flota →</button>
          </div>

          {/* Contadores semáforo */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {([
              { est: "verde"    as SemaforoEstado, valor: verdes,    icon: "🟢" },
              { est: "amarillo" as SemaforoEstado, valor: amarillos, icon: "🟡" },
              { est: "rojo"     as SemaforoEstado, valor: rojos,     icon: "🔴" },
            ]).map(s => {
              const cfg = SEMAFORO_CFG[s.est];
              return (
                <div key={s.est} className="rounded-xl p-3 text-center border"
                  style={{ background: cfg.bg, borderColor: cfg.dot + "44" }}>
                  <div className="text-xl mb-0.5">{s.icon}</div>
                  <div className="text-2xl font-black" style={{ color: cfg.color }}>{s.valor}</div>
                  <div className="text-[10px] font-bold uppercase tracking-wide mt-0.5"
                    style={{ color: cfg.color + "99" }}>{cfg.label}</div>
                </div>
              );
            })}
          </div>

          {/* Barra disponibilidad mecánica */}
          <div className="mb-4">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="font-bold text-gray-600">Disponibilidad mecánica</span>
              <span className="font-black" style={{
                color: disponibilidadMecanica >= 80 ? "#166534" : disponibilidadMecanica >= 60 ? "#854d0e" : "#991b1b"
              }}>{disponibilidadMecanica}%</span>
            </div>
            <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{
                width: `${disponibilidadMecanica}%`,
                background: disponibilidadMecanica >= 80 ? "#16a34a" : disponibilidadMecanica >= 60 ? "#eab308" : "#dc2626"
              }} />
            </div>
            <div className="text-[10px] text-gray-400 mt-1">
              Meta: 80% · {verdes} operativos de {vehiculos.length} unidades
            </div>
          </div>

          {/* Lista de vehículos con semáforo */}
          <div className="space-y-1.5">
            {datosFlota.slice(0, 6).map(d => {
              const cfg = SEMAFORO_CFG[d.semaforo.estado];
              const costoTotal = d.costoMant + d.costoComb;
              const km = Number(d.vehiculo.kilometraje_actual || 0);
              const cpk = km > 0 ? costoTotal / km : 0;
              return (
                <div key={d.vehiculo.id}
                  className="flex items-center justify-between py-1.5 border-b last:border-0"
                  style={{ borderColor: "#f8fafc" }}>
                  <div className="flex items-center gap-2">
                    {/* Semáforo mini */}
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: cfg.dot }} />
                    <span className="text-sm">{ICONO_CAT[d.vehiculo.categoria || "BUS"] || "🚌"}</span>
                    <div>
                      <span className="font-mono font-black text-sm text-gray-800">{d.vehiculo.placa}</span>
                      <span className="text-xs text-gray-400 ml-1">{d.vehiculo.categoria}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-bold" style={{ color: cfg.color }}>{d.semaforo.razon}</div>
                    {cpk > 0 && (
                      <div className="text-[10px] text-gray-400">
                        CPK: <span className="font-bold" style={{ color: cpk > 5 ? "#dc2626" : cpk > 2 ? "#eab308" : "#166534" }}>
                          S/ {cpk.toFixed(3)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {vehiculos.length === 0 && (
              <p className="text-sm text-gray-300 text-center py-4">Sin vehículos registrados</p>
            )}
            {vehiculos.length > 6 && (
              <button onClick={() => router.push("/vehiculos")}
                className="w-full text-xs text-center text-[#0b315f] font-bold pt-2 hover:underline">
                +{vehiculos.length - 6} vehículos más →
              </button>
            )}
          </div>
        </div>
      </section>

      {/* FILA 5 — Últimas reservas */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: "#f1f5f9" }}>
          <h2 className="text-sm font-bold text-gray-700">Últimas reservas</h2>
          <button onClick={() => router.push("/reservas")}
            className="text-xs font-bold text-[#0b315f] hover:underline">Ver todas →</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["ID", "Ruta", "Fecha", "Hora", "Tipo", "Estado", "Precio", "Margen"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reservas.slice(0, 8).map(r => {
                const estCfg = ESTADO_RESERVA[r.estado] || ESTADO_RESERVA.pendiente;
                return (
                  <tr key={r.id} className="border-t hover:bg-gray-50 transition-colors cursor-pointer"
                    style={{ borderColor: "#f1f5f9" }} onClick={() => router.push("/reservas")}>
                    <td className="p-3 font-black font-mono text-[#0b315f]">#{r.id}</td>
                    <td className="p-3 text-gray-700 max-w-[180px] truncate">
                      {r.origen} <span className="text-gray-400">→</span> {r.destino}
                    </td>
                    <td className="p-3 text-gray-500 text-xs">{fmtFecha(r.fecha_servicio)}</td>
                    <td className="p-3 text-gray-500 text-xs">{r.hora_servicio?.slice(0, 5) || "—"}</td>
                    <td className="p-3">
                      <span className="text-xs px-2 py-0.5 rounded font-bold"
                        style={{ background: r.tipo === "tercerizada" ? "#f3e8ff" : "#e0f2fe",
                          color: r.tipo === "tercerizada" ? "#7c3aed" : "#0369a1" }}>
                        {r.tipo}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="text-xs px-2.5 py-1 rounded-lg font-bold"
                        style={{ background: estCfg.bg, color: estCfg.color }}>
                        {estCfg.label}
                      </span>
                    </td>
                    <td className="p-3 font-bold text-gray-800">{fmtSoles(Number(r.precio_cliente || 0))}</td>
                    <td className="p-3 font-bold" style={{ color: Number(r.margen || 0) >= 0 ? "#166534" : "#991b1b" }}>
                      {fmtSoles(Number(r.margen || 0))}
                    </td>
                  </tr>
                );
              })}
              {reservas.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-gray-400">
                  <p className="text-2xl mb-1">📋</p>
                  <p>No hay reservas registradas</p>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {reservas.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>Mostrando 8 de {reservas.length} reservas</span>
            <span>AFA ERP · Dashboard</span>
          </div>
        )}
      </section>

    </main>
  );
}