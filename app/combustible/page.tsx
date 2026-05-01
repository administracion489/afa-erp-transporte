"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Vehiculo = {
  id: number;
  placa: string;
  categoria?: string;
};

type Combustible = {
  id: number;
  vehiculo_id: number | null;
  fecha: string;
  kilometraje: number;
  galones: number;
  precio_galon: number;
  total: number;
  grifo: string | null;
  conductor: string | null;
  observaciones: string | null;
};

export default function CombustiblePage() {
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [registros, setRegistros] = useState<Combustible[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    vehiculo_id: "",
    fecha: "",
    kilometraje: "",
    galones: "",
    precio_galon: "",
    grifo: "",
    conductor: "",
    observaciones: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [vehiculosRes, combustibleRes] = await Promise.all([
      supabase.from("vehiculos").select("id, placa, categoria").order("placa"),
      supabase.from("combustible").select("*").order("fecha", { ascending: false }),
    ]);

    if (vehiculosRes.error) alert(vehiculosRes.error.message);
    else setVehiculos(vehiculosRes.data || []);

    if (combustibleRes.error) alert(combustibleRes.error.message);
    else setRegistros(combustibleRes.data || []);

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
      kilometraje: "",
      galones: "",
      precio_galon: "",
      grifo: "",
      conductor: "",
      observaciones: "",
    });
  };

  const nombreVehiculo = (id: number | null) =>
    vehiculos.find((v) => v.id === id)?.placa || "-";

  const guardar = async () => {
    if (!form.vehiculo_id || !form.fecha) {
      alert("Selecciona vehículo y fecha");
      return;
    }

    const payload = {
      vehiculo_id: Number(form.vehiculo_id),
      fecha: form.fecha,
      kilometraje: Number(form.kilometraje || 0),
      galones: Number(form.galones || 0),
      precio_galon: Number(form.precio_galon || 0),
      grifo: form.grifo || null,
      conductor: form.conductor || null,
      observaciones: form.observaciones || null,
    };

    if (editandoId) {
      const { error } = await supabase
        .from("combustible")
        .update(payload)
        .eq("id", editandoId);

      if (error) return alert(error.message);
    } else {
      const { error } = await supabase.from("combustible").insert(payload);

      if (error) return alert(error.message);
    }

    limpiar();
    cargarDatos();
  };

  const editar = (r: Combustible) => {
    setEditandoId(r.id);
    setForm({
      vehiculo_id: r.vehiculo_id ? String(r.vehiculo_id) : "",
      fecha: r.fecha || "",
      kilometraje: String(r.kilometraje || ""),
      galones: String(r.galones || ""),
      precio_galon: String(r.precio_galon || ""),
      grifo: r.grifo || "",
      conductor: r.conductor || "",
      observaciones: r.observaciones || "",
    });
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar registro de combustible?")) return;

    const { error } = await supabase.from("combustible").delete().eq("id", id);

    if (error) return alert(error.message);

    cargarDatos();
  };

  const totalGastado = registros.reduce(
    (sum, r) => sum + Number(r.total || 0),
    0
  );

  const totalGalones = registros.reduce(
    (sum, r) => sum + Number(r.galones || 0),
    0
  );

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Combustible</h1>
        <p className="text-gray-600">
          Control de abastecimientos, kilometraje, consumo y gasto por vehículo.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Registros</p>
          <p className="text-2xl font-bold">{registros.length}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Galones totales</p>
          <p className="text-2xl font-bold">{totalGalones.toFixed(2)}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Gasto total</p>
          <p className="text-2xl font-bold text-red-600">
            S/ {totalGastado.toFixed(2)}
          </p>
        </div>
      </section>

      <section className="bg-white rounded-xl shadow border p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar abastecimiento" : "Nuevo abastecimiento"}
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

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Kilometraje"
            value={form.kilometraje}
            onChange={(e) => setForm({ ...form, kilometraje: e.target.value })}
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Galones"
            value={form.galones}
            onChange={(e) => setForm({ ...form, galones: e.target.value })}
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Precio por galón S/"
            value={form.precio_galon}
            onChange={(e) => setForm({ ...form, precio_galon: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Grifo"
            value={form.grifo}
            onChange={(e) => setForm({ ...form, grifo: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Conductor"
            value={form.conductor}
            onChange={(e) => setForm({ ...form, conductor: e.target.value })}
          />

          <input
            className="border rounded-lg p-3 md:col-span-2"
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
        <h2 className="text-xl font-bold mb-4">Historial de combustible</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Fecha</th>
              <th className="p-3 text-left">Vehículo</th>
              <th className="p-3 text-left">KM</th>
              <th className="p-3 text-left">Galones</th>
              <th className="p-3 text-left">Precio/galón</th>
              <th className="p-3 text-left">Total</th>
              <th className="p-3 text-left">Grifo</th>
              <th className="p-3 text-left">Conductor</th>
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
            ) : registros.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-5 text-center">
                  No hay registros.
                </td>
              </tr>
            ) : (
              registros.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-3">{r.fecha}</td>
                  <td className="p-3 font-bold">{nombreVehiculo(r.vehiculo_id)}</td>
                  <td className="p-3">{Number(r.kilometraje || 0).toFixed(0)}</td>
                  <td className="p-3">{Number(r.galones || 0).toFixed(2)}</td>
                  <td className="p-3">
                    S/ {Number(r.precio_galon || 0).toFixed(2)}
                  </td>
                  <td className="p-3 font-bold text-red-600">
                    S/ {Number(r.total || 0).toFixed(2)}
                  </td>
                  <td className="p-3">{r.grifo || "-"}</td>
                  <td className="p-3">{r.conductor || "-"}</td>
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