"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function ReportesPage() {
  const [resumen, setResumen] = useState<any>(null);
  const [reservas, setReservas] = useState<any[]>([]);
  const [gastos, setGastos] = useState<any[]>([]);
  const [facturas, setFacturas] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const cargarDatos = async () => {
    setLoading(true);

    const [resumenRes, reservasRes, gastosRes, facturasRes] =
      await Promise.all([
        supabase.from("resumen_erp").select("*").single(),
        supabase.from("reservas").select("*").order("id", { ascending: false }),
        supabase.from("gastos").select("*").order("fecha", { ascending: false }),
        supabase.from("facturas").select("*").order("id", { ascending: false }),
      ]);

    if (resumenRes.error) alert(resumenRes.error.message);
    else setResumen(resumenRes.data);

    setReservas(reservasRes.data || []);
    setGastos(gastosRes.data || []);
    setFacturas(facturasRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const totalReservas = Number(resumen?.total_reservas || 0);
  const ventasReservas = Number(resumen?.total_ventas_reservas || 0);
  const margenReservas = Number(resumen?.total_margen_reservas || 0);
  const totalFacturado = Number(resumen?.total_facturado || 0);
  const totalGastos = Number(resumen?.total_gastos || 0);
  const utilidadEstimada = totalFacturado - totalGastos;

  const gastosPorCategoria = gastos.reduce((acc: any, g) => {
    acc[g.categoria] = (acc[g.categoria] || 0) + Number(g.monto || 0);
    return acc;
  }, {});

  const reservasPorTipo = reservas.reduce((acc: any, r) => {
    acc[r.tipo] = (acc[r.tipo] || 0) + 1;
    return acc;
  }, {});

  const facturasPorEstado = facturas.reduce((acc: any, f) => {
    acc[f.estado] = (acc[f.estado] || 0) + Number(f.total || 0);
    return acc;
  }, {});

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Reportes</h1>
        <p className="text-gray-600">
          Resumen financiero, operativo y documental del ERP.
        </p>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border shadow p-6 text-center">
          Cargando reportes...
        </div>
      ) : (
        <>
          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Clientes</p>
              <p className="text-2xl font-bold">
                {resumen?.total_clientes || 0}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Reservas</p>
              <p className="text-2xl font-bold">{totalReservas}</p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Ventas reservas</p>
              <p className="text-2xl font-bold text-green-600">
                S/ {ventasReservas.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Margen reservas</p>
              <p className="text-2xl font-bold text-blue-600">
                S/ {margenReservas.toFixed(2)}
              </p>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Facturado</p>
              <p className="text-2xl font-bold text-green-600">
                S/ {totalFacturado.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Gastos</p>
              <p className="text-2xl font-bold text-red-600">
                S/ {totalGastos.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Utilidad estimada</p>
              <p
                className={`text-2xl font-bold ${
                  utilidadEstimada >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                S/ {utilidadEstimada.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Combustible</p>
              <p className="text-2xl font-bold text-red-600">
                S/ {Number(resumen?.total_combustible || 0).toFixed(2)}
              </p>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Mantenimiento</p>
              <p className="text-2xl font-bold text-red-600">
                S/ {Number(resumen?.total_mantenimiento || 0).toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Docs vencidos</p>
              <p className="text-2xl font-bold text-red-600">
                {resumen?.documentos_vencidos || 0}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Docs por vencer</p>
              <p className="text-2xl font-bold text-yellow-600">
                {resumen?.documentos_por_vencer || 0}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Seguros por vencer</p>
              <p className="text-2xl font-bold text-yellow-600">
                {resumen?.seguros_por_vencer || 0}
              </p>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Gastos por categoría</h2>

              {Object.keys(gastosPorCategoria).length === 0 ? (
                <p className="text-gray-500">Sin gastos registrados.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(gastosPorCategoria).map(([cat, monto]) => (
                    <div key={cat} className="flex justify-between border-b pb-2">
                      <span>{cat}</span>
                      <span className="font-bold text-red-600">
                        S/ {Number(monto).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Reservas por tipo</h2>

              {Object.keys(reservasPorTipo).length === 0 ? (
                <p className="text-gray-500">Sin reservas registradas.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(reservasPorTipo).map(([tipo, cantidad]) => (
                    <div key={tipo} className="flex justify-between border-b pb-2">
                      <span>{tipo}</span>
                      <span className="font-bold">{Number(cantidad)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Facturas por estado</h2>

              {Object.keys(facturasPorEstado).length === 0 ? (
                <p className="text-gray-500">Sin facturas registradas.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(facturasPorEstado).map(([estado, total]) => (
                    <div
                      key={estado}
                      className="flex justify-between border-b pb-2"
                    >
                      <span>{estado}</span>
                      <span className="font-bold text-green-600">
                        S/ {Number(total).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
            <h2 className="text-xl font-bold mb-4">Últimas reservas</h2>

            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">ID</th>
                  <th className="p-3 text-left">Ruta</th>
                  <th className="p-3 text-left">Tipo</th>
                  <th className="p-3 text-left">Estado</th>
                  <th className="p-3 text-left">Precio</th>
                  <th className="p-3 text-left">Margen</th>
                </tr>
              </thead>

              <tbody>
                {reservas.slice(0, 10).map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-3">{r.id}</td>
                    <td className="p-3">
                      {r.origen} → {r.destino}
                    </td>
                    <td className="p-3">{r.tipo}</td>
                    <td className="p-3">{r.estado}</td>
                    <td className="p-3">
                      S/ {Number(r.precio_cliente || 0).toFixed(2)}
                    </td>
                    <td className="p-3 font-bold text-green-600">
                      S/ {Number(r.margen || 0).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}