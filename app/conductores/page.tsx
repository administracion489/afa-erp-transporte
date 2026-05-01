"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Conductor = {
  id: number;
  nombre: string;
  licencia: string;
  vencimiento_licencia: string | null;
  estado: "disponible" | "no_disponible";
  telefono: string | null;
  created_at?: string;
};

export default function ConductoresPage() {
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    nombre: "",
    licencia: "",
    vencimiento_licencia: "",
    estado: "disponible",
    telefono: "",
  });

  const cargarConductores = async () => {
    setLoading(true);

    const { data, error } = await supabase
      .from("conductores")
      .select("*")
      .order("id", { ascending: false });

    if (error) alert(error.message);
    else setConductores(data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarConductores();
  }, []);

  const limpiarFormulario = () => {
    setEditandoId(null);
    setForm({
      nombre: "",
      licencia: "",
      vencimiento_licencia: "",
      estado: "disponible",
      telefono: "",
    });
  };

  const estadoLicencia = (fecha: string | null) => {
    if (!fecha) return "sin_fecha";

    const hoy = new Date();
    const vencimiento = new Date(fecha);
    const diferenciaDias = Math.ceil(
      (vencimiento.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (diferenciaDias < 0) return "vencida";
    if (diferenciaDias <= 30) return "por_vencer";
    return "vigente";
  };

  const guardarConductor = async () => {
    if (!form.nombre || !form.licencia) {
      alert("Completa nombre y licencia");
      return;
    }

    const payload = {
      nombre: form.nombre,
      licencia: form.licencia,
      vencimiento_licencia: form.vencimiento_licencia || null,
      estado: form.estado,
      telefono: form.telefono || null,
    };

    if (editandoId) {
      const { error } = await supabase
        .from("conductores")
        .update(payload)
        .eq("id", editandoId);

      if (error) {
        alert(error.message);
        return;
      }
    } else {
      const { error } = await supabase.from("conductores").insert(payload);

      if (error) {
        alert(error.message);
        return;
      }
    }

    limpiarFormulario();
    cargarConductores();
  };

  const editarConductor = (conductor: Conductor) => {
    setEditandoId(conductor.id);

    setForm({
      nombre: conductor.nombre || "",
      licencia: conductor.licencia || "",
      vencimiento_licencia: conductor.vencimiento_licencia || "",
      estado: conductor.estado || "disponible",
      telefono: conductor.telefono || "",
    });
  };

  const eliminarConductor = async (id: number) => {
    if (!confirm("¿Eliminar conductor?")) return;

    const { error } = await supabase.from("conductores").delete().eq("id", id);

    if (error) {
      alert(error.message);
      return;
    }

    cargarConductores();
  };

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Conductores</h1>
        <p className="text-gray-600">
          Registro de conductores, licencias, vencimientos y disponibilidad.
        </p>
      </div>

      <section className="bg-white rounded-xl shadow border p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar conductor" : "Nuevo conductor"}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            className="border rounded-lg p-3"
            placeholder="Nombre del conductor"
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Licencia"
            value={form.licencia}
            onChange={(e) => setForm({ ...form, licencia: e.target.value })}
          />

          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.vencimiento_licencia}
            onChange={(e) =>
              setForm({ ...form, vencimiento_licencia: e.target.value })
            }
          />

          <select
            className="border rounded-lg p-3"
            value={form.estado}
            onChange={(e) => setForm({ ...form, estado: e.target.value })}
          >
            <option value="disponible">Disponible</option>
            <option value="no_disponible">No disponible</option>
          </select>

          <input
            className="border rounded-lg p-3"
            placeholder="Teléfono"
            value={form.telefono}
            onChange={(e) => setForm({ ...form, telefono: e.target.value })}
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={guardarConductor}
            className="bg-slate-900 text-white px-6 py-3 rounded-lg font-bold"
          >
            {editandoId ? "Actualizar conductor" : "Guardar conductor"}
          </button>

          {editandoId && (
            <button
              onClick={limpiarFormulario}
              className="bg-gray-200 px-6 py-3 rounded-lg font-bold"
            >
              Cancelar
            </button>
          )}
        </div>
      </section>

      <section className="bg-white rounded-xl shadow border p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Lista de conductores</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">ID</th>
              <th className="p-3 text-left">Conductor</th>
              <th className="p-3 text-left">Licencia</th>
              <th className="p-3 text-left">Vencimiento</th>
              <th className="p-3 text-left">Estado licencia</th>
              <th className="p-3 text-left">Disponibilidad</th>
              <th className="p-3 text-left">Teléfono</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="p-5 text-center">
                  Cargando...
                </td>
              </tr>
            ) : conductores.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-5 text-center">
                  No hay conductores registrados.
                </td>
              </tr>
            ) : (
              conductores.map((c) => {
                const estado = estadoLicencia(c.vencimiento_licencia);

                return (
                  <tr key={c.id} className="border-t">
                    <td className="p-3">{c.id}</td>

                    <td className="p-3 font-bold">{c.nombre}</td>

                    <td className="p-3">{c.licencia}</td>

                    <td className="p-3">{c.vencimiento_licencia || "-"}</td>

                    <td className="p-3">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${
                          estado === "vigente"
                            ? "bg-green-100 text-green-700"
                            : estado === "por_vencer"
                            ? "bg-yellow-100 text-yellow-700"
                            : estado === "vencida"
                            ? "bg-red-100 text-red-700"
                            : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {estado === "vigente"
                          ? "VIGENTE"
                          : estado === "por_vencer"
                          ? "POR VENCER"
                          : estado === "vencida"
                          ? "VENCIDA"
                          : "SIN FECHA"}
                      </span>
                    </td>

                    <td className="p-3">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${
                          c.estado === "disponible"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {c.estado === "disponible"
                          ? "DISPONIBLE"
                          : "NO DISPONIBLE"}
                      </span>
                    </td>

                    <td className="p-3">{c.telefono || "-"}</td>

                    <td className="p-3 text-right space-x-2">
                      <button
                        onClick={() => editarConductor(c)}
                        className="bg-blue-600 text-white px-3 py-1 rounded"
                      >
                        Editar
                      </button>

                      <button
                        onClick={() => eliminarConductor(c.id)}
                        className="bg-red-600 text-white px-3 py-1 rounded"
                      >
                        Eliminar
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}