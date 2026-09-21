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

      <PanelOcupacionSemanal />

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
// ══════════════════════════════════════════════════════════════════════════════
// Reporte semanal de ocupación — disparo manual y estado
//
// El correo sale solo los sábados a las 20:00 (Lima) por cron. Este panel existe
// por dos razones concretas:
//
//  · PODER COMPROBARLO SIN ESPERAR AL SÁBADO. Un envío automático que solo se
//    puede verificar una vez por semana se despliega a ciegas.
//  · PODER REEMITIR una semana cuyo cron falló, nombrando su fecha de cierre.
//
// El botón NO salta el candado del envío doble: el endpoint relee la bitácora y
// el índice único de Postgres remata. Reemitir una semana ya enviada responde
// «ya se envió este periodo» en vez de mandarlo otra vez — un correo no se
// des-envía, así que ese candado no se puede aflojar ni «para probar».
// ══════════════════════════════════════════════════════════════════════════════
function PanelOcupacionSemanal() {
  const [corriendo, setCorriendo] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [fin, setFin] = useState("");

  const emitir = async () => {
    // `forzarDia` salta SOLO la comprobación de «¿hoy le toca a este cliente?», para
    // poder probar sin esperar a su fecha. La VENTANA no se toca: cada cliente sigue
    // recibiendo el periodo que tiene configurado, cerrando en la fecha indicada.
    // Nunca se inventa un periodo distinto del que se va a mandar de verdad.
    if (!confirm("Se van a enviar correos REALES a los clientes que tengan el reporte activado. ¿Continuar?")) return;
    setCorriendo(true); setRes(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const r = await fetch("/api/reportes/ocupacion-semanal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
        body: JSON.stringify({ fin: fin || undefined, forzarDia: true }),
      });
      setRes(await r.json());
    } catch (e: any) {
      setRes({ error: String(e?.message ?? e) });
    } finally {
      setCorriendo(false);
    }
  };

  const sinMigracion = typeof res?.motivo === "string" && res.motivo.startsWith("sin_migracion");

  return (
    <section className="bg-white rounded-xl border shadow p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-lg">Ocupación semanal</h2>
          <p className="text-sm text-gray-600 max-w-2xl mt-1">
            A las <b>20:00</b> sale, a cada cliente que lo tenga activado, el detalle de cuánta gente
            viajó frente a los asientos contratados, ruta por ruta, con el Excel del detalle, los
            manifiestos y los reportes de servicio. Se mide el <b>día de más afluencia</b>, nunca el
            promedio. <b>Cada cuánto se envía</b> (sábados · días 1 y 16 · día 1 · fin de mes) y
            <b>qué periodo abarca</b> (7, 15, 30 días o el mes calendario) se eligen por separado, en
            <b>Clientes → editar → Reporte semanal de ocupación</b>, junto con el interruptor de las
            sugerencias. El cron corre a diario y cada cliente sale el día que le toca.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-gray-500">
            <span className="block mb-1">Periodo que cierra el</span>
            <input type="date" value={fin} onChange={e => setFin(e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <button onClick={emitir} disabled={corriendo}
            className={`px-4 py-2 rounded-lg text-sm font-bold text-white ${corriendo ? "bg-gray-400" : "bg-[#0b315f] hover:bg-[#0a2a50]"}`}>
            {corriendo ? "Enviando…" : "Enviar ahora"}
          </button>
        </div>
      </div>

      {sinMigracion && (
        <p className="mt-3 text-sm bg-amber-50 border-l-4 border-amber-500 rounded-r px-3 py-2 text-amber-900">
          Falta correr <code className="font-mono text-xs">supabase/reportes-01-ocupacion-semanal.sql</code>.
          Hasta entonces no se manda nada y el interruptor por cliente no se guarda.
        </p>
      )}

      {res?.error && <p className="mt-3 text-sm text-red-700">{res.error}</p>}

      {res && !res.error && !sinMigracion && (
        <div className="mt-4 text-sm">
          {res.periodo && (
            <p className="text-gray-500 text-xs mb-2">
              Periodo {res.periodo.inicio} → {res.periodo.fin}
            </p>
          )}
          {res.motivo === "ningun_cliente_activo" ? (
            <p className="text-gray-600">
              Ningún cliente tiene el reporte activado todavía. Se enciende en <b>Clientes → editar →
              Reporte semanal de ocupación</b>.
            </p>
          ) : res.motivo === "hoy_no_toca_a_nadie" ? (
            <p className="text-gray-600">
              Hoy no le toca a ningún cliente según su cadencia, así que el cron no habría emitido.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b">
                  <th className="py-1.5">Cliente</th><th className="py-1.5">Rutas</th><th className="py-1.5">Enviado a</th>
                </tr>
              </thead>
              <tbody>
                {(res.clientes ?? []).map((c: any, i: number) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 font-medium">{c.cliente}</td>
                    <td className="py-1.5 text-gray-600">{c.rutas}</td>
                    <td className="py-1.5 text-gray-600">
                      {c.error
                        ? <span className="text-red-700">{c.error}</span>
                        : c.enviados?.length
                          ? c.enviados.join(", ")
                          : <span className="text-gray-400">{c.omitido ?? "—"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
