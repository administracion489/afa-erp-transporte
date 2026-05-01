"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function DashboardPage() {
  const [clientes, setClientes] = useState<any[]>([]);
  const [reservas, setReservas] = useState<any[]>([]);
  const [vehiculos, setVehiculos] = useState<any[]>([]);
  const [conductores, setConductores] = useState<any[]>([]);
  const [facturas, setFacturas] = useState<any[]>([]);
  const [gastos, setGastos] = useState<any[]>([]);
  const [documentos, setDocumentos] = useState<any[]>([]);
  const [seguros, setSeguros] = useState<any[]>([]);
  const [mantenimiento, setMantenimiento] = useState<any[]>([]);
  const [combustible, setCombustible] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const cargarDatos = async () => {
    setLoading(true);

    const [
      clientesRes,
      reservasRes,
      vehiculosRes,
      conductoresRes,
      facturasRes,
      gastosRes,
      documentosRes,
      segurosRes,
      mantenimientoRes,
      combustibleRes,
    ] = await Promise.all([
      supabase.from("clientes").select("*"),
      supabase.from("reservas").select("*").order("id", { ascending: false }),
      supabase.from("vehiculos").select("*"),
      supabase.from("conductores").select("*"),
      supabase.from("facturas").select("*"),
      supabase.from("gastos").select("*"),
      supabase.from("documentos_empresa").select("*"),
      supabase.from("seguros").select("*"),
      supabase.from("mantenimiento").select("*"),
      supabase.from("combustible").select("*"),
    ]);

    setClientes(clientesRes.data || []);
    setReservas(reservasRes.data || []);
    setVehiculos(vehiculosRes.data || []);
    setConductores(conductoresRes.data || []);
    setFacturas(facturasRes.data || []);
    setGastos(gastosRes.data || []);
    setDocumentos(documentosRes.data || []);
    setSeguros(segurosRes.data || []);
    setMantenimiento(mantenimientoRes.data || []);
    setCombustible(combustibleRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const estadoVencimiento = (fecha: string | null) => {
    if (!fecha) return "vigente";
    const hoy = new Date();
    const venc = new Date(fecha);
    const dias = Math.ceil((venc.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
    if (dias < 0) return "vencido";
    if (dias <= 30) return "por_vencer";
    return "vigente";
  };

  const totalVentasReservas = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const totalMargenReservas = reservas.reduce((s, r) => s + Number(r.margen || 0), 0);
  const totalFacturado = facturas.reduce((s, f) => s + Number(f.total || 0), 0);
  const totalGastos = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
  const gastoCombustible = combustible.reduce((s, c) => s + Number(c.total || 0), 0);
  const gastoMantenimiento = mantenimiento.reduce((s, m) => s + Number(m.costo || 0), 0);
  const utilidad = totalFacturado - totalGastos;

  const reservasPendientes = reservas.filter((r) => r.estado === "pendiente");
  const reservasConfirmadas = reservas.filter((r) => r.estado === "confirmada");
  const reservasFinalizadas = reservas.filter((r) => r.estado === "finalizada");
  const reservasCanceladas = reservas.filter((r) => r.estado === "cancelada");
  const reservasTercerizadas = reservas.filter((r) => r.tipo === "tercerizada");

  const vehiculosAptos = vehiculos.filter((v) => {
    const estado = String(v.aptitud || v.estado || "").toUpperCase();
    return estado === "APTO" || estado === "DISPONIBLE";
  });

  const conductoresDisponibles = conductores.filter((c) => {
    const estado = String(c.estado || "disponible").toLowerCase();
    return estado !== "no_disponible" && estado !== "inactivo";
  });

  const docsPorVencer = documentos.filter((d) => estadoVencimiento(d.fecha_vencimiento) === "por_vencer");
  const docsVencidos = documentos.filter((d) => estadoVencimiento(d.fecha_vencimiento) === "vencido");
  const segurosPorVencer = seguros.filter((s) => estadoVencimiento(s.fecha_vencimiento) === "por_vencer");
  const segurosVencidos = seguros.filter((s) => estadoVencimiento(s.fecha_vencimiento) === "vencido");
  const clientesBloqueados = clientes.filter((c) => c.estado === "bloqueado");

  const eficienciaFlota = vehiculos.length
    ? Math.round((vehiculosAptos.length / vehiculos.length) * 100)
    : 0;

  const avanceFacturacion = totalVentasReservas
    ? Math.min(100, Math.round((totalFacturado / totalVentasReservas) * 100))
    : 0;

  const margenPorcentaje = totalFacturado
    ? Math.round((utilidad / totalFacturado) * 100)
    : 0;

  const Card = ({
    titulo,
    valor,
    detalle,
    color = "text-slate-900",
  }: {
    titulo: string;
    valor: string | number;
    detalle: string;
    color?: string;
  }) => (
    <div className="bg-white rounded-2xl border shadow p-5">
      <p className="text-sm text-gray-500">{titulo}</p>
      <p className={`text-3xl font-black ${color}`}>{valor}</p>
      <p className="text-sm text-gray-500 mt-1">{detalle}</p>
    </div>
  );

  const Donut = ({
    value,
    label,
    color,
  }: {
    value: number;
    label: string;
    color: string;
  }) => {
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (value / 100) * circumference;

    return (
      <div className="flex flex-col items-center justify-center">
        <svg width="125" height="125">
          <circle
            cx="62"
            cy="62"
            r={radius}
            stroke="#e5e7eb"
            strokeWidth="16"
            fill="none"
          />
          <circle
            cx="62"
            cy="62"
            r={radius}
            stroke={color}
            strokeWidth="16"
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 62 62)"
          />
          <text
            x="62"
            y="58"
            textAnchor="middle"
            className="fill-slate-900 text-xl font-bold"
          >
            {value}%
          </text>
          <text
            x="62"
            y="78"
            textAnchor="middle"
            className="fill-slate-500 text-xs"
          >
            {label}
          </text>
        </svg>
      </div>
    );
  };

  const Barra = ({
    label,
    valor,
    max,
    color,
  }: {
    label: string;
    valor: number;
    max: number;
    color: string;
  }) => {
    const width = max ? Math.min(100, (valor / max) * 100) : 0;

    return (
      <div>
        <div className="flex justify-between text-sm mb-1">
          <span>{label}</span>
          <b>{valor}</b>
        </div>
        <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full ${color}`} style={{ width: `${width}%` }} />
        </div>
      </div>
    );
  };

  const maxReservas = Math.max(
    reservasPendientes.length,
    reservasConfirmadas.length,
    reservasFinalizadas.length,
    reservasCanceladas.length,
    1
  );

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-black">Dashboard Principal</h1>
        <p className="text-gray-600">
          Panel visual del ERP: operaciones, flota, reservas, finanzas y alertas.
        </p>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border shadow p-6 text-center">
          Cargando dashboard...
        </div>
      ) : (
        <>
          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card titulo="Clientes" valor={clientes.length} detalle="Total registrados" />
            <Card titulo="Reservas" valor={reservas.length} detalle={`${reservasConfirmadas.length} confirmadas`} color="text-blue-600" />
            <Card titulo="Vehículos aptos" valor={`${vehiculosAptos.length}/${vehiculos.length}`} detalle="Disponibles para operar" color="text-green-600" />
            <Card titulo="Conductores" valor={`${conductoresDisponibles.length}/${conductores.length}`} detalle="Disponibles" color="text-green-600" />
          </section>

          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card titulo="Ventas reservas" valor={`S/ ${totalVentasReservas.toFixed(2)}`} detalle="Ingresos proyectados" color="text-green-600" />
            <Card titulo="Facturado" valor={`S/ ${totalFacturado.toFixed(2)}`} detalle="Comprobantes emitidos" color="text-green-600" />
            <Card titulo="Gastos" valor={`S/ ${totalGastos.toFixed(2)}`} detalle="Egresos registrados" color="text-red-600" />
            <Card titulo="Utilidad estimada" valor={`S/ ${utilidad.toFixed(2)}`} detalle="Facturado menos gastos" color={utilidad >= 0 ? "text-green-600" : "text-red-600"} />
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Eficiencia operativa</h2>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Donut value={eficienciaFlota} label="Flota apta" color="#0ea5e9" />
                <Donut value={avanceFacturacion} label="Facturación" color="#16a34a" />
                <Donut value={Math.max(0, margenPorcentaje)} label="Margen" color="#2563eb" />
              </div>
            </div>

            <div className="bg-white rounded-2xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Reservas por estado</h2>

              <div className="space-y-4">
                <Barra label="Pendientes" valor={reservasPendientes.length} max={maxReservas} color="bg-yellow-500" />
                <Barra label="Confirmadas" valor={reservasConfirmadas.length} max={maxReservas} color="bg-green-500" />
                <Barra label="Finalizadas" valor={reservasFinalizadas.length} max={maxReservas} color="bg-blue-500" />
                <Barra label="Canceladas" valor={reservasCanceladas.length} max={maxReservas} color="bg-red-500" />
              </div>
            </div>

            <div className="bg-white rounded-2xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Costos operativos</h2>

              <div className="space-y-4">
                <div className="flex justify-between border-b pb-2">
                  <span>Combustible</span>
                  <b className="text-red-600">S/ {gastoCombustible.toFixed(2)}</b>
                </div>

                <div className="flex justify-between border-b pb-2">
                  <span>Mantenimiento</span>
                  <b className="text-red-600">S/ {gastoMantenimiento.toFixed(2)}</b>
                </div>

                <div className="flex justify-between border-b pb-2">
                  <span>Gastos generales</span>
                  <b className="text-red-600">S/ {totalGastos.toFixed(2)}</b>
                </div>

                <div className="flex justify-between">
                  <span>Margen reservas</span>
                  <b className="text-blue-600">S/ {totalMargenReservas.toFixed(2)}</b>
                </div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl border shadow p-6 xl:col-span-2">
              <h2 className="text-xl font-bold mb-4">Alertas críticas</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl bg-red-50 border border-red-100 p-4">
                  <p className="text-sm text-red-600">Documentos vencidos</p>
                  <p className="text-3xl font-black text-red-600">{docsVencidos.length}</p>
                </div>

                <div className="rounded-xl bg-yellow-50 border border-yellow-100 p-4">
                  <p className="text-sm text-yellow-700">Documentos por vencer</p>
                  <p className="text-3xl font-black text-yellow-700">{docsPorVencer.length}</p>
                </div>

                <div className="rounded-xl bg-red-50 border border-red-100 p-4">
                  <p className="text-sm text-red-600">Seguros vencidos</p>
                  <p className="text-3xl font-black text-red-600">{segurosVencidos.length}</p>
                </div>

                <div className="rounded-xl bg-yellow-50 border border-yellow-100 p-4">
                  <p className="text-sm text-yellow-700">Seguros por vencer</p>
                  <p className="text-3xl font-black text-yellow-700">{segurosPorVencer.length}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Próximas acciones</h2>

              <div className="space-y-3 text-sm">
                {reservasPendientes.length > 0 && (
                  <div className="bg-blue-50 text-blue-700 rounded-lg p-3">
                    Programar {reservasPendientes.length} reserva(s) pendiente(s).
                  </div>
                )}

                {docsVencidos.length > 0 && (
                  <div className="bg-red-50 text-red-700 rounded-lg p-3">
                    Revisar documentos vencidos.
                  </div>
                )}

                {segurosPorVencer.length > 0 && (
                  <div className="bg-yellow-50 text-yellow-700 rounded-lg p-3">
                    Renovar seguros próximos a vencer.
                  </div>
                )}

                {clientesBloqueados.length > 0 && (
                  <div className="bg-red-50 text-red-700 rounded-lg p-3">
                    Revisar clientes bloqueados.
                  </div>
                )}

                {reservasPendientes.length === 0 &&
                  docsVencidos.length === 0 &&
                  segurosPorVencer.length === 0 &&
                  clientesBloqueados.length === 0 && (
                    <div className="bg-green-50 text-green-700 rounded-lg p-3">
                      Operación estable.
                    </div>
                  )}
              </div>
            </div>
          </section>

          <section className="bg-white rounded-2xl border shadow p-6 overflow-x-auto">
            <h2 className="text-xl font-bold mb-4">Últimas reservas</h2>

            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">ID</th>
                  <th className="p-3 text-left">Ruta</th>
                  <th className="p-3 text-left">Fecha</th>
                  <th className="p-3 text-left">Tipo</th>
                  <th className="p-3 text-left">Estado</th>
                  <th className="p-3 text-left">Precio</th>
                  <th className="p-3 text-left">Margen</th>
                </tr>
              </thead>

              <tbody>
                {reservas.slice(0, 8).map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-3 font-bold">#{r.id}</td>
                    <td className="p-3">{r.origen} → {r.destino}</td>
                    <td className="p-3">{r.fecha_servicio || "-"}</td>
                    <td className="p-3">{r.tipo}</td>
                    <td className="p-3">
                      <span className="px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                        {r.estado?.replace("_", " ").toUpperCase()}
                      </span>
                    </td>
                    <td className="p-3 font-bold">
                      S/ {Number(r.precio_cliente || 0).toFixed(2)}
                    </td>
                    <td className="p-3 font-bold text-green-600">
                      S/ {Number(r.margen || 0).toFixed(2)}
                    </td>
                  </tr>
                ))}

                {reservas.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-5 text-center">
                      No hay reservas registradas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}