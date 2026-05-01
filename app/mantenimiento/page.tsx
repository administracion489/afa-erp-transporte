"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Vehiculo = {
  id: number;
  placa: string;
  categoria?: string;
};

type Mantenimiento = {
  id: number;
  vehiculo_id: number | null;
  fecha: string;
  tipo: "preventivo" | "correctivo";
  kilometraje: number;
  descripcion: string;
  proveedor: string | null;
  costo: number;
  estado: "pendiente" | "en_proceso" | "finalizado" | "cancelado";
  proximo_km: number;
  proxima_fecha: string | null;
  observaciones: string | null;
};

export default function MantenimientoPage() {
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [registros, setRegistros] = useState<Mantenimiento[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    vehiculo_id: "",
    fecha: "",
    tipo: "preventivo",
    kilometraje: "",
    descripcion: "",
    proveedor: "",
    costo: "",
    estado: "pendiente",
    proximo_km: "",
    proxima_fecha: "",
    observaciones: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [vehiculosRes, mantenimientoRes] = await Promise.all([
      supabase.from("vehiculos").select("id, placa, categoria").order("placa"),
      supabase
        .from("mantenimiento")
        .select("*")
        .order("fecha", { ascending: false }),
    ]);

    if (vehiculosRes.error) alert(vehiculosRes.error.message);
    else setVehiculos(vehiculosRes.data || []);

    if (mantenimientoRes.error) alert(mantenimientoRes.error.message);
    else setRegistros(mantenimientoRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const limpiar = () => {
    setEditandoId(null);
    setForm({
      vehiculo_id: "",
      fecha: "",
      tipo: "preventivo",
      kilometraje: "",
      descripcion: "",
      proveedor: "",
      costo: "",
      estado: "pendiente",
      proximo_km: "",
      proxima_fecha: "",
      observaciones: "",
    });
  };

  const nombreVehiculo = (id: number | null) =>
    vehiculos.find((v) => v.id === id)?.placa || "-";

  const guardar = async () => {
    if (!form.vehiculo_id || !form.fecha || !form.descripcion) {
      alert("Selecciona vehículo, fecha y descripción");
      return;
    }

    const payload = {
      vehiculo_id: Number(form.vehiculo_id),
      fecha: form.fecha,
      tipo: form.tipo,
      kilometraje: Number(form.kilometraje || 0),
      descripcion: form.descripcion,
      proveedor: form.proveedor || null,
      costo: Number(form.costo || 0),
      estado: form.estado,
      proximo_km: Number(form.proximo_km || 0),
      proxima_fecha: form.proxima_fecha || null,
      observaciones: form.observaciones || null,
    };

    if (editandoId) {
      const { error } = await supabase
        .from("mantenimiento")
        .update(payload)
        .eq("id", editandoId);

      if (error) return alert(error.message);
    } else {
      const { error } = await supabase.from("mantenimiento").insert(payload);

      if (error) return alert(error.message);
    }

    limpiar();
    cargarDatos();
  };

  const editar = (r: Mantenimiento) => {
    setEditandoId(r.id);

    setForm({
      vehiculo_id: r.vehiculo_id ? String(r.vehiculo_id) : "",
      fecha: r.fecha || "",
      tipo: r.tipo || "preventivo",
      kilometraje: String(r.kilometraje || ""),
      descripcion: r.descripcion || "",
      proveedor: r.proveedor || "",
      costo: String(r.costo || ""),
      estado: r.estado || "pendiente",
      proximo_km: String(r.proximo_km || ""),
      proxima_fecha: r.proxima_fecha || "",
      observaciones: r.observaciones || "",
    });
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar mantenimiento?")) return;

    const { error } = await supabase.from("mantenimiento").delete().eq("id", id);

    if (error) return alert(error.message);

    cargarDatos();
  };

  const totalCosto = registros.reduce(
    (sum, r) => sum + Number(r.costo || 0),
    0
  );

  const pendientes = registros.filter((r) => r.estado === "pendiente").length;

  const finalizados = registros.filter((r) => r.estado === "finalizado").length;

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Mantenimiento</h1>
        <p className="text-gray-600">
          Control preventivo y correctivo por vehículo, kilometraje, costos y próximos servicios.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Registros</p>
          <p className="text-2xl font-bold">{registros.length}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Pendientes</p>
          <p className="text-2xl font-bold text-yellow-600">{pendientes}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Finalizados</p>
          <p className="text-2xl font-bold text-green-600">{finalizados}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Costo total</p>
          <p className="text-2xl font-bold text-red-600">
            S/ {totalCosto.toFixed(2)}
          </p>
        </div>
      </section>

      <section className="bg-white rounded-xl shadow border p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar mantenimiento" : "Nuevo mantenimiento"}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <select
            className="border rounded-lg p-3"
            value={form.vehiculo_id}
            onChange={(e) => setForm({ ...form, vehiculo_id: e.target.value })}
          >
            <option value="">Seleccionar vehículo</option>
            {vehiculos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.placa} {v.categoria ? `- ${v.categoria}` : ""}
              </option>
            ))}
          </select>

          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.fecha}
            onChange={(e) => setForm({ ...form, fecha: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.tipo}
            onChange={(e) => setForm({ ...form, tipo: e.target.value })}
          >
            <option value="preventivo">Preventivo</option>
            <option value="correctivo">Correctivo</option>
          </select>

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Kilometraje actual"
            value={form.kilometraje}
            onChange={(e) => setForm({ ...form, kilometraje: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Proveedor / taller"
            value={form.proveedor}
            onChange={(e) => setForm({ ...form, proveedor: e.target.value })}
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Costo S/"
            value={form.costo}
            onChange={(e) => setForm({ ...form, costo: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.estado}
            onChange={(e) => setForm({ ...form, estado: e.target.value })}
          >
            <option value="pendiente">Pendiente</option>
            <option value="en_proceso">En proceso</option>
            <option value="finalizado">Finalizado</option>
            <option value="cancelado">Cancelado</option>
          </select>

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Próximo mantenimiento KM"
            value={form.proximo_km}
            onChange={(e) => setForm({ ...form, proximo_km: e.target.value })}
          />

          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.proxima_fecha}
            onChange={(e) =>
              setForm({ ...form, proxima_fecha: e.target.value })
            }
          />

          <input
            className="border rounded-lg p-3 md:col-span-3"
            placeholder="Descripción del mantenimiento"
            value={form.descripcion}
            onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
          />

          <input
            className="border rounded-lg p-3 md:col-span-3"
            placeholder="Observaciones"
            value={form.observaciones}
            onChange={(e) =>
              setForm({ ...form, observaciones: e.target.value })
            }
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={guardar}
            className="bg-slate-900 text-white px-6 py-3 rounded-lg font-bold"
          >
            {editandoId ? "Actualizar" : "Guardar"}
          </button>

          {editandoId && (
            <button
              onClick={limpiar}
              className="bg-gray-200 px-6 py-3 rounded-lg font-bold"
            >
              Cancelar
            </button>
          )}
        </div>
      </section>

      <section className="bg-white rounded-xl shadow border p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Historial de mantenimiento</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Fecha</th>
              <th className="p-3 text-left">Vehículo</th>
              <th className="p-3 text-left">Tipo</th>
              <th className="p-3 text-left">KM</th>
              <th className="p-3 text-left">Descripción</th>
              <th className="p-3 text-left">Proveedor</th>
              <th className="p-3 text-left">Costo</th>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-left">Próximo KM</th>
              <th className="p-3 text-left">Próxima fecha</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={11} className="p-5 text-center">
                  Cargando...
                </td>
              </tr>
            ) : registros.length === 0 ? (
              <tr>
                <td colSpan={11} className="p-5 text-center">
                  No hay registros.
                </td>
              </tr>
            ) : (
              registros.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-3">{r.fecha}</td>
                  <td className="p-3 font-bold">{nombreVehiculo(r.vehiculo_id)}</td>
                  <td className="p-3">{r.tipo}</td>
                  <td className="p-3">{Number(r.kilometraje || 0).toFixed(0)}</td>
                  <td className="p-3">{r.descripcion}</td>
                  <td className="p-3">{r.proveedor || "-"}</td>
                  <td className="p-3 font-bold text-red-600">
                    S/ {Number(r.costo || 0).toFixed(2)}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        r.estado === "finalizado"
                          ? "bg-green-100 text-green-700"
                          : r.estado === "en_proceso"
                          ? "bg-blue-100 text-blue-700"
                          : r.estado === "cancelado"
                          ? "bg-red-100 text-red-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {r.estado.toUpperCase()}
                    </span>
                  </td>
                  <td className="p-3">
                    {r.proximo_km ? Number(r.proximo_km).toFixed(0) : "-"}
                  </td>
                  <td className="p-3">{r.proxima_fecha || "-"}</td>
                  <td className="p-3 text-right space-x-2">
                    <button
                      onClick={() => editar(r)}
                      className="bg-blue-600 text-white px-3 py-1 rounded"
                    >
                      Editar
                    </button>

                    <button
                      onClick={() => eliminar(r.id)}
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