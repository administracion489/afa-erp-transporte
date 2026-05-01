"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Cliente = {
  id: number;
  nombre: string;
  estado?: string;
};

type Cotizacion = {
  id: number;
  cliente_id: number | null;
  origen: string;
  destino: string;
  km: number;
  precio_cliente: number;
  costo_estimado: number;
  margen_estimado: number;
  estado: "pendiente" | "aprobado" | "rechazado";
  pdf_url: string | null;
};

export default function CotizacionesPage() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    cliente_id: "",
    origen: "",
    destino: "",
    km: "",
    precio_cliente: "",
    costo_estimado: "",
    estado: "pendiente",
    pdf_url: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [clientesRes, cotizacionesRes] = await Promise.all([
      supabase.from("clientes").select("id, nombre, estado").order("nombre"),
      supabase.from("cotizaciones").select("*").order("id", { ascending: false }),
    ]);

    if (clientesRes.error) alert(clientesRes.error.message);
    else setClientes(clientesRes.data || []);

    if (cotizacionesRes.error) alert(cotizacionesRes.error.message);
    else setCotizaciones(cotizacionesRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const nombreCliente = (id: number | null) =>
    clientes.find((c) => c.id === id)?.nombre || "Sin cliente";

  const limpiar = () => {
    setForm({
      cliente_id: "",
      origen: "",
      destino: "",
      km: "",
      precio_cliente: "",
      costo_estimado: "",
      estado: "pendiente",
      pdf_url: "",
    });
  };

  const guardarCotizacion = async () => {
    if (!form.cliente_id || !form.origen || !form.destino) {
      alert("Selecciona cliente, origen y destino");
      return;
    }

    const cliente = clientes.find((c) => c.id === Number(form.cliente_id));

    if (cliente?.estado === "bloqueado") {
      alert("Cliente bloqueado. No se puede cotizar.");
      return;
    }

    const precio = Number(form.precio_cliente || 0);
    const costo = Number(form.costo_estimado || 0);

    const { error } = await supabase.from("cotizaciones").insert({
      cliente_id: Number(form.cliente_id),
      origen: form.origen,
      destino: form.destino,
      km: Number(form.km || 0),
      precio_cliente: precio,
      costo_estimado: costo,
      margen_estimado: precio - costo,
      estado: form.estado,
      pdf_url: form.pdf_url || null,
    });

    if (error) return alert(error.message);

    limpiar();
    cargarDatos();
  };

  const cambiarEstado = async (
    id: number,
    estado: "pendiente" | "aprobado" | "rechazado"
  ) => {
    const { error } = await supabase
      .from("cotizaciones")
      .update({ estado })
      .eq("id", id);

    if (error) return alert(error.message);
    cargarDatos();
  };

  const convertirAReserva = async (cotizacion: Cotizacion) => {
    if (cotizacion.estado !== "aprobado") {
      alert("Solo una cotización aprobada puede convertirse en reserva");
      return;
    }

    const existe = await supabase
      .from("reservas")
      .select("id")
      .eq("cotizacion_id", cotizacion.id)
      .maybeSingle();

    if (existe.data) {
      alert("Esta cotización ya fue convertida en reserva");
      return;
    }

    const { error } = await supabase.from("reservas").insert({
      cliente_id: cotizacion.cliente_id,
      cotizacion_id: cotizacion.id,
      origen: cotizacion.origen,
      destino: cotizacion.destino,
      precio_cliente: cotizacion.precio_cliente,
      costo_proveedor: 0,
      fecha_servicio: new Date().toISOString().split("T")[0],
      hora_servicio: new Date().toTimeString().slice(0, 5),
      estado: "pendiente",
      tipo: "propia",
    });

    if (error) return alert(error.message);

    alert("Cotización convertida a reserva");
    cargarDatos();
  };

  const eliminarCotizacion = async (id: number) => {
    if (!confirm("¿Eliminar cotización?")) return;

    const { error } = await supabase.from("cotizaciones").delete().eq("id", id);

    if (error) return alert(error.message);

    cargarDatos();
  };

  const total = cotizaciones.length;
  const pendientes = cotizaciones.filter((c) => c.estado === "pendiente").length;
  const aprobadas = cotizaciones.filter((c) => c.estado === "aprobado").length;
  const rechazadas = cotizaciones.filter((c) => c.estado === "rechazado").length;

  const valorCotizado = cotizaciones.reduce(
    (sum, c) => sum + Number(c.precio_cliente || 0),
    0
  );

  const margenTotal = cotizaciones.reduce(
    (sum, c) => sum + Number(c.margen_estimado || 0),
    0
  );

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Cotizaciones</h1>
        <p className="text-gray-600">
          Gestión comercial de solicitudes, precios, márgenes y conversión a reservas.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Total cotizaciones</p>
          <p className="text-2xl font-bold">{total}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Pendientes</p>
          <p className="text-2xl font-bold text-yellow-600">{pendientes}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Aprobadas</p>
          <p className="text-2xl font-bold text-green-600">{aprobadas}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Rechazadas</p>
          <p className="text-2xl font-bold text-red-600">{rechazadas}</p>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Valor cotizado</p>
          <p className="text-2xl font-bold text-green-600">
            S/ {valorCotizado.toFixed(2)}
          </p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Margen estimado</p>
          <p className="text-2xl font-bold text-blue-600">
            S/ {margenTotal.toFixed(2)}
          </p>
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 space-y-4">
        <h2 className="text-xl font-bold">Nueva cotización</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <select
            className="border rounded-lg p-3"
            value={form.cliente_id}
            onChange={(e) => setForm({ ...form, cliente_id: e.target.value })}
          >
            <option value="">Seleccionar cliente</option>
            {clientes.map((c) => (
              <option
                key={c.id}
                value={c.id}
                disabled={c.estado === "bloqueado"}
              >
                {c.nombre} {c.estado === "bloqueado" ? "- BLOQUEADO" : ""}
              </option>
            ))}
          </select>

          <input
            className="border rounded-lg p-3"
            placeholder="Origen"
            value={form.origen}
            onChange={(e) => setForm({ ...form, origen: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Destino"
            value={form.destino}
            onChange={(e) => setForm({ ...form, destino: e.target.value })}
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Kilómetros estimados"
            value={form.km}
            onChange={(e) => setForm({ ...form, km: e.target.value })}
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Precio cliente S/"
            value={form.precio_cliente}
            onChange={(e) =>
              setForm({ ...form, precio_cliente: e.target.value })
            }
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Costo estimado S/"
            value={form.costo_estimado}
            onChange={(e) =>
              setForm({ ...form, costo_estimado: e.target.value })
            }
          />

          <select
            className="border rounded-lg p-3"
            value={form.estado}
            onChange={(e) => setForm({ ...form, estado: e.target.value })}
          >
            <option value="pendiente">Pendiente</option>
            <option value="aprobado">Aprobado</option>
            <option value="rechazado">Rechazado</option>
          </select>

          <input
            className="border rounded-lg p-3 md:col-span-2"
            placeholder="URL PDF / documento"
            value={form.pdf_url}
            onChange={(e) => setForm({ ...form, pdf_url: e.target.value })}
          />
        </div>

        <button
          onClick={guardarCotizacion}
          className="bg-slate-900 text-white px-6 py-3 rounded-lg font-bold"
        >
          Guardar cotización
        </button>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Lista de cotizaciones</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Cliente</th>
              <th className="p-3 text-left">Ruta</th>
              <th className="p-3 text-left">KM</th>
              <th className="p-3 text-left">Precio</th>
              <th className="p-3 text-left">Costo</th>
              <th className="p-3 text-left">Margen</th>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-left">PDF</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="p-5 text-center">
                  Cargando...
                </td>
              </tr>
            ) : cotizaciones.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-5 text-center">
                  No hay cotizaciones registradas.
                </td>
              </tr>
            ) : (
              cotizaciones.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="p-3 font-bold">
                    {nombreCliente(c.cliente_id)}
                  </td>

                  <td className="p-3">
                    {c.origen} → {c.destino}
                  </td>

                  <td className="p-3">{Number(c.km || 0).toFixed(0)}</td>

                  <td className="p-3 font-bold">
                    S/ {Number(c.precio_cliente || 0).toFixed(2)}
                  </td>

                  <td className="p-3">
                    S/ {Number(c.costo_estimado || 0).toFixed(2)}
                  </td>

                  <td className="p-3 font-bold text-green-600">
                    S/ {Number(c.margen_estimado || 0).toFixed(2)}
                  </td>

                  <td className="p-3">
                    <select
                      className="border rounded-lg p-2"
                      value={c.estado}
                      onChange={(e) =>
                        cambiarEstado(
                          c.id,
                          e.target.value as "pendiente" | "aprobado" | "rechazado"
                        )
                      }
                    >
                      <option value="pendiente">Pendiente</option>
                      <option value="aprobado">Aprobado</option>
                      <option value="rechazado">Rechazado</option>
                    </select>
                  </td>

                  <td className="p-3">
                    {c.pdf_url ? (
                      <a
                        href={c.pdf_url}
                        target="_blank"
                        className="text-blue-600 underline"
                      >
                        Ver PDF
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>

                  <td className="p-3 text-right space-x-2">
                    <button
                      onClick={() => convertirAReserva(c)}
                      disabled={c.estado !== "aprobado"}
                      className="bg-green-600 text-white px-3 py-1 rounded disabled:bg-gray-400"
                    >
                      A reserva
                    </button>

                    <button
                      onClick={() => eliminarCotizacion(c.id)}
                      className="bg-red-600 text-white px-3 py-1 rounded"
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}