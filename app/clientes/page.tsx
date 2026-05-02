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

    const { data, error } = await (supabase as any)
      .from("clientes")
      .select("*")
      .order("id", { ascending: false });

    if (error) {
      alert(error.message);
    } else {
      setClientes(data || []);
    }

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
      const { error } = await (supabase as any)
        .from("clientes")
        .update(payload)
        .eq("id", editandoId);

      if (error) return alert(error.message);
    } else {
      const { error } = await (supabase as any)
        .from("clientes")
        .insert(payload);

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

    const { error } = await (supabase as any)
      .from("clientes")
      .delete()
      .eq("id", id);

    if (error) return alert(error.message);

    cargarClientes();
  };

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Clientes</h1>
        <p className="text-gray-600">
          Gestión de clientes AFA Transportes
        </p>
      </div>

      <section className="bg-white rounded-xl border shadow p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar cliente" : "Nuevo cliente"}
        </h2>

        <input
          className="border p-3 rounded w-full"
          placeholder="Nombre"
          value={form.nombre}
          onChange={(e) =>
            setForm({ ...form, nombre: e.target.value })
          }
        />

        <button
          onClick={guardarCliente}
          className="bg-black text-white px-4 py-2 rounded"
        >
          Guardar
        </button>
      </section>

      <section className="bg-white rounded-xl border shadow p-6">
        <h2 className="text-xl font-bold mb-4">Lista</h2>

        {loading ? (
          <p>Cargando...</p>
        ) : (
          clientes.map((c) => (
            <div
              key={c.id}
              className="border-b py-2 flex justify-between"
            >
              <span>{c.nombre}</span>

              <div className="space-x-2">
                <button
                  onClick={() => editarCliente(c)}
                  className="text-blue-600"
                >
                  Editar
                </button>

                <button
                  onClick={() => eliminarCliente(c.id)}
                  className="text-red-600"
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))
        )}
      </section>
    </main>
  );
}