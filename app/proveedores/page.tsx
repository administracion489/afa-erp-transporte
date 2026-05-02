"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Proveedor = {
  id: number;
  nombre: string;
  ruc: string | null;
  telefono: string | null;
  email: string | null;
  direccion: string | null;
  tipo: string;
  contacto_nombre: string | null;
  contacto_telefono: string | null;
  estado: string;
  observaciones: string | null;
};

export default function ProveedoresPage() {
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    nombre: "",
    ruc: "",
    telefono: "",
    email: "",
    direccion: "",
    tipo: "transporte",
    contacto_nombre: "",
    contacto_telefono: "",
    estado: "activo",
    observaciones: "",
  });

  async function cargarProveedores() {
    setLoading(true);

    const { data, error } = await supabase
      .from("proveedores")
      .select("*")
      .order("id", { ascending: false });

    if (error) alert(error.message);
    else setProveedores(data || []);

    setLoading(false);
  }

  useEffect(() => {
    cargarProveedores();
  }, []);

  function limpiar() {
    setEditandoId(null);
    setForm({
      nombre: "",
      ruc: "",
      telefono: "",
      email: "",
      direccion: "",
      tipo: "transporte",
      contacto_nombre: "",
      contacto_telefono: "",
      estado: "activo",
      observaciones: "",
    });
  }

  async function guardar() {
    if (!form.nombre.trim()) {
      alert("Ingresa el nombre del proveedor");
      return;
    }

    const payload = {
      nombre: form.nombre,
      ruc: form.ruc || null,
      telefono: form.telefono || null,
      email: form.email || null,
      direccion: form.direccion || null,
      tipo: form.tipo,
      contacto_nombre: form.contacto_nombre || null,
      contacto_telefono: form.contacto_telefono || null,
      estado: form.estado,
      observaciones: form.observaciones || null,
    };

    const { error } = editandoId
      ? await supabase.from("proveedores").update(payload).eq("id", editandoId)
      : await supabase.from("proveedores").insert(payload);

    if (error) {
      alert(error.message);
      return;
    }

    limpiar();
    cargarProveedores();
  }

  function editar(p: Proveedor) {
    setEditandoId(p.id);
    setForm({
      nombre: p.nombre || "",
      ruc: p.ruc || "",
      telefono: p.telefono || "",
      email: p.email || "",
      direccion: p.direccion || "",
      tipo: p.tipo || "transporte",
      contacto_nombre: p.contacto_nombre || "",
      contacto_telefono: p.contacto_telefono || "",
      estado: p.estado || "activo",
      observaciones: p.observaciones || "",
    });
  }

  async function eliminar(id: number) {
    if (!confirm("¿Eliminar proveedor?")) return;

    const { error } = await supabase.from("proveedores").delete().eq("id", id);

    if (error) {
      alert(error.message);
      return;
    }

    cargarProveedores();
  }

  const activos = proveedores.filter((p) => p.estado === "activo").length;
  const bloqueados = proveedores.filter((p) => p.estado === "bloqueado").length;
  const transporte = proveedores.filter((p) => p.tipo === "transporte").length;

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Proveedores</h1>
        <p className="text-gray-600">
          Gestión de proveedores externos, talleres, combustible, repuestos y servicios tercerizados.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Total proveedores</p>
          <p className="text-2xl font-bold">{proveedores.length}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Activos</p>
          <p className="text-2xl font-bold text-green-600">{activos}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Bloqueados</p>
          <p className="text-2xl font-bold text-red-600">{bloqueados}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Transporte</p>
          <p className="text-2xl font-bold text-blue-600">{transporte}</p>
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar proveedor" : "Nuevo proveedor"}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input className="border rounded-lg p-3" placeholder="Nombre / Razón social" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
          <input className="border rounded-lg p-3" placeholder="RUC" value={form.ruc} onChange={(e) => setForm({ ...form, ruc: e.target.value })} />

          <select className="border rounded-lg p-3" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
            <option value="transporte">Transporte tercerizado</option>
            <option value="taller">Taller</option>
            <option value="combustible">Combustible</option>
            <option value="repuestos">Repuestos</option>
            <option value="seguros">Seguros</option>
            <option value="administrativo">Administrativo</option>
            <option value="otro">Otro</option>
          </select>

          <input className="border rounded-lg p-3" placeholder="Teléfono" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
          <input className="border rounded-lg p-3" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />

          <select className="border rounded-lg p-3" value={form.estado} onChange={(e) => setForm({ ...form, estado: e.target.value })}>
            <option value="activo">Activo</option>
            <option value="inactivo">Inactivo</option>
            <option value="bloqueado">Bloqueado</option>
          </select>

          <input className="border rounded-lg p-3 md:col-span-3" placeholder="Dirección" value={form.direccion} onChange={(e) => setForm({ ...form, direccion: e.target.value })} />
          <input className="border rounded-lg p-3" placeholder="Nombre de contacto" value={form.contacto_nombre} onChange={(e) => setForm({ ...form, contacto_nombre: e.target.value })} />
          <input className="border rounded-lg p-3" placeholder="Teléfono de contacto" value={form.contacto_telefono} onChange={(e) => setForm({ ...form, contacto_telefono: e.target.value })} />
          <input className="border rounded-lg p-3" placeholder="Observaciones" value={form.observaciones} onChange={(e) => setForm({ ...form, observaciones: e.target.value })} />
        </div>

        <div className="flex gap-3">
          <button onClick={guardar} className="bg-slate-900 text-white px-6 py-3 rounded-lg font-bold">
            {editandoId ? "Actualizar proveedor" : "Guardar proveedor"}
          </button>

          {editandoId && (
            <button onClick={limpiar} className="bg-gray-200 px-6 py-3 rounded-lg font-bold">
              Cancelar
            </button>
          )}
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Lista de proveedores</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-left">Proveedor</th>
              <th className="p-3 text-left">RUC</th>
              <th className="p-3 text-left">Tipo</th>
              <th className="p-3 text-left">Teléfono</th>
              <th className="p-3 text-left">Email</th>
              <th className="p-3 text-left">Contacto</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="p-5 text-center">Cargando...</td>
              </tr>
            ) : proveedores.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-5 text-center">No hay proveedores registrados.</td>
              </tr>
            ) : (
              proveedores.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        p.estado === "activo"
                          ? "bg-green-100 text-green-700"
                          : p.estado === "bloqueado"
                          ? "bg-red-100 text-red-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {p.estado.toUpperCase()}
                    </span>
                  </td>

                  <td className="p-3 font-bold">{p.nombre}</td>
                  <td className="p-3">{p.ruc || "-"}</td>
                  <td className="p-3">{p.tipo}</td>
                  <td className="p-3">{p.telefono || "-"}</td>
                  <td className="p-3">{p.email || "-"}</td>

                  <td className="p-3">
                    {p.contacto_nombre || "-"}
                    {p.contacto_telefono ? (
                      <div className="text-xs text-gray-500">
                        {p.contacto_telefono}
                      </div>
                    ) : null}
                  </td>

                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => editar(p)} className="bg-blue-600 text-white px-3 py-1 rounded">
                      Editar
                    </button>

                    <button onClick={() => eliminar(p.id)} className="bg-red-600 text-white px-3 py-1 rounded">
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