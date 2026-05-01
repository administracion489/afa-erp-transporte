"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Cliente = {
  id: number;
  nombre: string;
  tipo: string;
  ruc: string | null;
  telefono: string | null;
  email: string | null;
  estado: string;
  operativo_nombre: string | null;
  operativo_celular: string | null;
  operativo_email: string | null;
  administrativo_nombre: string | null;
  administrativo_celular: string | null;
  administrativo_email: string | null;
};

export default function ClientesPage() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    nombre: "",
    tipo: "B2B",
    ruc: "",
    telefono: "",
    email: "",
    estado: "activo",
    operativo_nombre: "",
    operativo_celular: "",
    operativo_email: "",
    administrativo_nombre: "",
    administrativo_celular: "",
    administrativo_email: "",
  });

  const cargarClientes = async () => {
    setLoading(true);

    const { data, error } = await supabase
      .from("clientes")
      .select("*")
      .order("id", { ascending: false });

    if (error) alert(error.message);
    else setClientes(data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarClientes();
  }, []);

  const limpiarFormulario = () => {
    setEditandoId(null);
    setForm({
      nombre: "",
      tipo: "B2B",
      ruc: "",
      telefono: "",
      email: "",
      estado: "activo",
      operativo_nombre: "",
      operativo_celular: "",
      operativo_email: "",
      administrativo_nombre: "",
      administrativo_celular: "",
      administrativo_email: "",
    });
  };

  const guardarCliente = async () => {
    if (!form.nombre.trim()) {
      alert("Ingresa el nombre del cliente");
      return;
    }

    const payload = {
      nombre: form.nombre,
      tipo: form.tipo,
      ruc: form.ruc || null,
      telefono: form.telefono || null,
      email: form.email || null,
      estado: form.estado,
      operativo_nombre: form.operativo_nombre || null,
      operativo_celular: form.operativo_celular || null,
      operativo_email: form.operativo_email || null,
      administrativo_nombre: form.administrativo_nombre || null,
      administrativo_celular: form.administrativo_celular || null,
      administrativo_email: form.administrativo_email || null,
    };

    if (editandoId) {
      const { error } = await supabase
        .from("clientes")
        .update(payload)
        .eq("id", editandoId);

      if (error) return alert(error.message);
    } else {
      const { error } = await supabase.from("clientes").insert(payload);

      if (error) return alert(error.message);
    }

    limpiarFormulario();
    cargarClientes();
  };

  const editarCliente = (cliente: Cliente) => {
    setEditandoId(cliente.id);

    setForm({
      nombre: cliente.nombre || "",
      tipo: cliente.tipo || "B2B",
      ruc: cliente.ruc || "",
      telefono: cliente.telefono || "",
      email: cliente.email || "",
      estado: cliente.estado || "activo",
      operativo_nombre: cliente.operativo_nombre || "",
      operativo_celular: cliente.operativo_celular || "",
      operativo_email: cliente.operativo_email || "",
      administrativo_nombre: cliente.administrativo_nombre || "",
      administrativo_celular: cliente.administrativo_celular || "",
      administrativo_email: cliente.administrativo_email || "",
    });
  };

  const eliminarCliente = async (id: number) => {
    if (!confirm("¿Eliminar cliente?")) return;

    const { error } = await supabase.from("clientes").delete().eq("id", id);

    if (error) return alert(error.message);

    cargarClientes();
  };

  const totalClientes = clientes.length;
  const clientesActivos = clientes.filter((c) => c.estado === "activo").length;
  const clientesBloqueados = clientes.filter((c) => c.estado === "bloqueado").length;
  const clientesB2B = clientes.filter((c) => c.tipo === "B2B").length;

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Clientes</h1>
        <p className="text-gray-600">
          Gestión de clientes, contactos operativos, contactos administrativos y estado comercial.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Total clientes</p>
          <p className="text-2xl font-bold">{totalClientes}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Activos</p>
          <p className="text-2xl font-bold text-green-600">{clientesActivos}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Bloqueados</p>
          <p className="text-2xl font-bold text-red-600">{clientesBloqueados}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Clientes B2B</p>
          <p className="text-2xl font-bold text-blue-600">{clientesB2B}</p>
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 space-y-5">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar cliente" : "Nuevo cliente"}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            className="border rounded-lg p-3"
            placeholder="Nombre / Razón social"
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.tipo}
            onChange={(e) => setForm({ ...form, tipo: e.target.value })}
          >
            <option value="B2B">B2B / Empresa</option>
            <option value="B2C">B2C / Persona</option>
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.estado}
            onChange={(e) => setForm({ ...form, estado: e.target.value })}
          >
            <option value="activo">Activo</option>
            <option value="bloqueado">Bloqueado</option>
          </select>

          <input
            className="border rounded-lg p-3"
            placeholder="RUC / DNI"
            value={form.ruc}
            onChange={(e) => setForm({ ...form, ruc: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Teléfono principal"
            value={form.telefono}
            onChange={(e) => setForm({ ...form, telefono: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Email principal"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>

        <div className="border rounded-xl p-4 space-y-3">
          <h3 className="font-bold text-gray-800">Contacto operativo</h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              className="border rounded-lg p-3"
              placeholder="Nombre y apellidos"
              value={form.operativo_nombre}
              onChange={(e) =>
                setForm({ ...form, operativo_nombre: e.target.value })
              }
            />

            <input
              className="border rounded-lg p-3"
              placeholder="Celular"
              value={form.operativo_celular}
              onChange={(e) =>
                setForm({ ...form, operativo_celular: e.target.value })
              }
            />

            <input
              className="border rounded-lg p-3"
              placeholder="Correo"
              value={form.operativo_email}
              onChange={(e) =>
                setForm({ ...form, operativo_email: e.target.value })
              }
            />
          </div>
        </div>

        <div className="border rounded-xl p-4 space-y-3">
          <h3 className="font-bold text-gray-800">Contacto administrativo</h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              className="border rounded-lg p-3"
              placeholder="Nombre y apellidos"
              value={form.administrativo_nombre}
              onChange={(e) =>
                setForm({ ...form, administrativo_nombre: e.target.value })
              }
            />

            <input
              className="border rounded-lg p-3"
              placeholder="Celular"
              value={form.administrativo_celular}
              onChange={(e) =>
                setForm({ ...form, administrativo_celular: e.target.value })
              }
            />

            <input
              className="border rounded-lg p-3"
              placeholder="Correo"
              value={form.administrativo_email}
              onChange={(e) =>
                setForm({ ...form, administrativo_email: e.target.value })
              }
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={guardarCliente}
            className="bg-slate-900 text-white px-6 py-3 rounded-lg font-bold"
          >
            {editandoId ? "Actualizar cliente" : "Guardar cliente"}
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

      <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Lista de clientes</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-left">Cliente</th>
              <th className="p-3 text-left">Tipo</th>
              <th className="p-3 text-left">RUC / DNI</th>
              <th className="p-3 text-left">Teléfono</th>
              <th className="p-3 text-left">Email</th>
              <th className="p-3 text-left">Contacto operativo</th>
              <th className="p-3 text-left">Contacto administrativo</th>
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
            ) : clientes.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-5 text-center">
                  No hay clientes registrados.
                </td>
              </tr>
            ) : (
              clientes.map((cliente) => (
                <tr key={cliente.id} className="border-t">
                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        cliente.estado === "activo"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {cliente.estado?.toUpperCase() || "ACTIVO"}
                    </span>
                  </td>

                  <td className="p-3 font-bold">{cliente.nombre}</td>
                  <td className="p-3">{cliente.tipo}</td>
                  <td className="p-3">{cliente.ruc || "-"}</td>
                  <td className="p-3">{cliente.telefono || "-"}</td>
                  <td className="p-3">{cliente.email || "-"}</td>

                  <td className="p-3">
                    <div className="font-semibold">
                      {cliente.operativo_nombre || "-"}
                    </div>
                    <div className="text-xs text-gray-500">
                      {cliente.operativo_celular || "-"}
                    </div>
                    <div className="text-xs text-gray-500">
                      {cliente.operativo_email || "-"}
                    </div>
                  </td>

                  <td className="p-3">
                    <div className="font-semibold">
                      {cliente.administrativo_nombre || "-"}
                    </div>
                    <div className="text-xs text-gray-500">
                      {cliente.administrativo_celular || "-"}
                    </div>
                    <div className="text-xs text-gray-500">
                      {cliente.administrativo_email || "-"}
                    </div>
                  </td>

                  <td className="p-3 text-right space-x-2">
                    <button
                      onClick={() => editarCliente(cliente)}
                      className="bg-blue-600 text-white px-3 py-1 rounded"
                    >
                      Editar
                    </button>

                    <button
                      onClick={() => eliminarCliente(cliente.id)}
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