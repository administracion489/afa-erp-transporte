"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Vehiculo = {
  id: number;
  placa: string;
  categoria?: string;
};

type Neumatico = {
  id: number;
  vehiculo_id: number | null;
  codigo: string | null;
  marca: string | null;
  medida: string | null;
  posicion: string | null;
  fecha_instalacion: string | null;
  km_instalacion: number;
  km_actual: number;
  vida_util_km: number;
  estado: "activo" | "rotado" | "retirado" | "dañado";
  observaciones: string | null;
};

export default function NeumaticosPage() {
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [neumaticos, setNeumaticos] = useState<Neumatico[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    vehiculo_id: "",
    codigo: "",
    marca: "",
    medida: "",
    posicion: "",
    fecha_instalacion: "",
    km_instalacion: "",
    km_actual: "",
    vida_util_km: "50000",
    estado: "activo",
    observaciones: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [vehiculosRes, neumaticosRes] = await Promise.all([
      supabase.from("vehiculos").select("id, placa, categoria").order("placa"),
      supabase
        .from("neumaticos")
        .select("*")
        .order("id", { ascending: false }),
    ]);

    if (vehiculosRes.error) alert(vehiculosRes.error.message);
    else setVehiculos(vehiculosRes.data || []);

    if (neumaticosRes.error) alert(neumaticosRes.error.message);
    else setNeumaticos(neumaticosRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const limpiar = () => {
    setEditandoId(null);
    setForm({
      vehiculo_id: "",
      codigo: "",
      marca: "",
      medida: "",
      posicion: "",
      fecha_instalacion: "",
      km_instalacion: "",
      km_actual: "",
      vida_util_km: "50000",
      estado: "activo",
      observaciones: "",
    });
  };

  const nombreVehiculo = (id: number | null) =>
    vehiculos.find((v) => v.id === id)?.placa || "-";

  const calcularUso = (n: Neumatico) => {
    return Number(n.km_actual || 0) - Number(n.km_instalacion || 0);
  };

  const calcularPorcentaje = (n: Neumatico) => {
    const uso = calcularUso(n);
    const vida = Number(n.vida_util_km || 1);
    return Math.min(100, Math.max(0, (uso / vida) * 100));
  };

  const estadoVida = (n: Neumatico) => {
    const porcentaje = calcularPorcentaje(n);

    if (n.estado === "dañado") return "DAÑADO";
    if (n.estado === "retirado") return "RETIRADO";
    if (porcentaje >= 90) return "CAMBIAR";
    if (porcentaje >= 75) return "POR CAMBIAR";
    return "OK";
  };

  const guardar = async () => {
    if (!form.vehiculo_id || !form.codigo || !form.marca || !form.medida) {
      alert("Completa vehículo, código, marca y medida");
      return;
    }

    const payload = {
      vehiculo_id: Number(form.vehiculo_id),
      codigo: form.codigo,
      marca: form.marca,
      medida: form.medida,
      posicion: form.posicion || null,
      fecha_instalacion: form.fecha_instalacion || null,
      km_instalacion: Number(form.km_instalacion || 0),
      km_actual: Number(form.km_actual || 0),
      vida_util_km: Number(form.vida_util_km || 50000),
      estado: form.estado,
      observaciones: form.observaciones || null,
    };

    if (editandoId) {
      const { error } = await supabase
        .from("neumaticos")
        .update(payload)
        .eq("id", editandoId);

      if (error) return alert(error.message);
    } else {
      const { error } = await supabase.from("neumaticos").insert(payload);

      if (error) return alert(error.message);
    }

    limpiar();
    cargarDatos();
  };

  const editar = (n: Neumatico) => {
    setEditandoId(n.id);

    setForm({
      vehiculo_id: n.vehiculo_id ? String(n.vehiculo_id) : "",
      codigo: n.codigo || "",
      marca: n.marca || "",
      medida: n.medida || "",
      posicion: n.posicion || "",
      fecha_instalacion: n.fecha_instalacion || "",
      km_instalacion: String(n.km_instalacion || ""),
      km_actual: String(n.km_actual || ""),
      vida_util_km: String(n.vida_util_km || "50000"),
      estado: n.estado || "activo",
      observaciones: n.observaciones || "",
    });
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar neumático?")) return;

    const { error } = await supabase.from("neumaticos").delete().eq("id", id);

    if (error) return alert(error.message);

    cargarDatos();
  };

  const activos = neumaticos.filter((n) => n.estado === "activo").length;
  const porCambiar = neumaticos.filter(
    (n) => estadoVida(n) === "POR CAMBIAR" || estadoVida(n) === "CAMBIAR"
  ).length;
  const dañados = neumaticos.filter((n) => n.estado === "dañado").length;

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Neumáticos</h1>
        <p className="text-gray-600">
          Control de neumáticos por vehículo, posición, vida útil, rotación y cambio.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Total neumáticos</p>
          <p className="text-2xl font-bold">{neumaticos.length}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Activos</p>
          <p className="text-2xl font-bold text-green-600">{activos}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Por cambiar</p>
          <p className="text-2xl font-bold text-yellow-600">{porCambiar}</p>
        </div>

        <div className="bg-white rounded-xl shadow border p-4">
          <p className="text-sm text-gray-500">Dañados</p>
          <p className="text-2xl font-bold text-red-600">{dañados}</p>
        </div>
      </section>

      <section className="bg-white rounded-xl shadow border p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar neumático" : "Nuevo neumático"}
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
            className="border rounded-lg p-3"
            placeholder="Código / serie"
            value={form.codigo}
            onChange={(e) => setForm({ ...form, codigo: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Marca"
            value={form.marca}
            onChange={(e) => setForm({ ...form, marca: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Medida Ej: 295/80R22.5"
            value={form.medida}
            onChange={(e) => setForm({ ...form, medida: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.posicion}
            onChange={(e) => setForm({ ...form, posicion: e.target.value })}
          >
            <option value="">Posición</option>
            <option value="delantera_izquierda">Delantera izquierda</option>
            <option value="delantera_derecha">Delantera derecha</option>
            <option value="posterior_izquierda">Posterior izquierda</option>
            <option value="posterior_derecha">Posterior derecha</option>
            <option value="repuesto">Repuesto</option>
          </select>

          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.fecha_instalacion}
            onChange={(e) =>
              setForm({ ...form, fecha_instalacion: e.target.value })
            }
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="KM instalación"
            value={form.km_instalacion}
            onChange={(e) =>
              setForm({ ...form, km_instalacion: e.target.value })
            }
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="KM actual"
            value={form.km_actual}
            onChange={(e) => setForm({ ...form, km_actual: e.target.value })}
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Vida útil KM"
            value={form.vida_util_km}
            onChange={(e) => setForm({ ...form, vida_util_km: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.estado}
            onChange={(e) => setForm({ ...form, estado: e.target.value })}
          >
            <option value="activo">Activo</option>
            <option value="rotado">Rotado</option>
            <option value="retirado">Retirado</option>
            <option value="dañado">Dañado</option>
          </select>

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
        <h2 className="text-xl font-bold mb-4">Historial de neumáticos</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Vehículo</th>
              <th className="p-3 text-left">Código</th>
              <th className="p-3 text-left">Marca</th>
              <th className="p-3 text-left">Medida</th>
              <th className="p-3 text-left">Posición</th>
              <th className="p-3 text-left">KM uso</th>
              <th className="p-3 text-left">Vida</th>
              <th className="p-3 text-left">Estado vida</th>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="p-5 text-center">
                  Cargando...
                </td>
              </tr>
            ) : neumaticos.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-5 text-center">
                  No hay neumáticos registrados.
                </td>
              </tr>
            ) : (
              neumaticos.map((n) => {
                const uso = calcularUso(n);
                const porcentaje = calcularPorcentaje(n);
                const vida = estadoVida(n);

                return (
                  <tr key={n.id} className="border-t">
                    <td className="p-3 font-bold">
                      {nombreVehiculo(n.vehiculo_id)}
                    </td>
                    <td className="p-3">{n.codigo || "-"}</td>
                    <td className="p-3">{n.marca || "-"}</td>
                    <td className="p-3">{n.medida || "-"}</td>
                    <td className="p-3">{n.posicion || "-"}</td>
                    <td className="p-3">{uso.toFixed(0)} km</td>
                    <td className="p-3">{porcentaje.toFixed(0)}%</td>
                    <td className="p-3">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${
                          vida === "OK"
                            ? "bg-green-100 text-green-700"
                            : vida === "POR CAMBIAR"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {vida}
                      </span>
                    </td>
                    <td className="p-3">{n.estado}</td>
                    <td className="p-3 text-right space-x-2">
                      <button
                        onClick={() => editar(n)}
                        className="bg-blue-600 text-white px-3 py-1 rounded"
                      >
                        Editar
                      </button>

                      <button
                        onClick={() => eliminar(n.id)}
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