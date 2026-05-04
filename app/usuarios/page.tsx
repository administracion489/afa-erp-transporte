"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePermiso } from "@/lib/usePermiso";

type Usuario = {
  id: string;
  email: string;
  nombre: string;
  rol: string;
  activo?: boolean;
};

type Permiso = {
  usuario_id: string;
  modulo: string;
  permitido: boolean;
};

const MODULOS = [
  "dashboard",
  "reservas",
  "cotizaciones",
  "clientes",
  "proveedores",
  "conductores",
  "vehiculos",
  "combustible",
  "mantenimiento",
  "neumaticos",
  "documentos",
  "facturacion",
  "gastos",
  "seguros",
  "reportes",
  "usuarios",
];

const nombresModulo: Record<string, string> = {
  dashboard: "Dashboard",
  reservas: "Reservas",
  cotizaciones: "Cotizaciones",
  clientes: "Clientes",
  proveedores: "Proveedores",
  conductores: "Conductores",
  vehiculos: "Vehículos",
  combustible: "Combustible",
  mantenimiento: "Mantenimiento",
  neumaticos: "Neumáticos",
  documentos: "Documentos",
  facturacion: "Facturación",
  gastos: "Gastos",
  seguros: "Seguros",
  reportes: "Reportes",
  usuarios: "Usuarios",
};

export default function UsuariosPage() {
  const { validando, permitido } = usePermiso("usuarios");

  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [permisos, setPermisos] = useState<any>({});
  const [loading, setLoading] = useState(false);
  const [creando, setCreando] = useState(false);

  const [form, setForm] = useState({
    nombre: "",
    email: "",
    password: "",
    rol: "operador",
  });

  useEffect(() => {
    cargarUsuarios();
  }, []);

  async function cargarUsuarios() {
    setLoading(true);

    const { data, error } = await supabase
      .from("usuarios")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      alert(error.message);
      setLoading(false);
      return;
    }

    setUsuarios(data || []);
    await cargarPermisos(data || []);
    setLoading(false);
  }

  async function cargarPermisos(listaUsuarios: Usuario[]) {
    const { data } = await supabase.from("permisos_usuario").select("*");

    const mapa: any = {};

    listaUsuarios.forEach((u) => {
      mapa[u.id] = {};
      MODULOS.forEach((m) => {
        mapa[u.id][m] = false;
      });
    });

    (data as Permiso[])?.forEach((p) => {
      if (!mapa[p.usuario_id]) return;
      mapa[p.usuario_id][p.modulo] = p.permitido;
    });

    setPermisos(mapa);
  }

  async function crearUsuario() {
    if (!form.nombre.trim() || !form.email.trim() || !form.password.trim()) {
      alert("Completa nombre, correo y contraseña");
      return;
    }

    if (form.password.length < 6) {
      alert("La contraseña debe tener mínimo 6 caracteres");
      return;
    }

    setCreando(true);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;

    if (!token) {
      alert("Sesión no válida");
      setCreando(false);
      return;
    }

    const response = await fetch("/api/crear-usuario", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(form),
    });

    const result = await response.json();

    if (!response.ok) {
      alert(result.error || "No se pudo crear usuario");
      setCreando(false);
      return;
    }

    alert("Usuario creado correctamente");

    setForm({
      nombre: "",
      email: "",
      password: "",
      rol: "operador",
    });

    setCreando(false);
    cargarUsuarios();
  }

  function togglePermiso(userId: string, modulo: string) {
    const nuevo = { ...permisos };
    nuevo[userId] = { ...nuevo[userId] };
    nuevo[userId][modulo] = !nuevo[userId][modulo];
    setPermisos(nuevo);
  }

  async function guardarPermisos(userId: string) {
    const permisosUsuario = permisos[userId];

    const inserts = Object.keys(permisosUsuario).map((modulo) => ({
      usuario_id: userId,
      modulo,
      permitido: permisosUsuario[modulo],
    }));

    const { error } = await supabase
      .from("permisos_usuario")
      .upsert(inserts, { onConflict: "usuario_id,modulo" });

    if (error) {
      alert(error.message);
      return;
    }

    alert("Permisos guardados");
  }

  async function cambiarActivo(user: Usuario) {
    const nuevoEstado = !user.activo;

    const { error } = await supabase
      .from("usuarios")
      .update({ activo: nuevoEstado })
      .eq("id", user.id);

    if (error) {
      alert(error.message);
      return;
    }

    cargarUsuarios();
  }

  async function cambiarRol(user: Usuario, rol: string) {
    const { error } = await supabase
      .from("usuarios")
      .update({ rol })
      .eq("id", user.id);

    if (error) {
      alert(error.message);
      return;
    }

    cargarUsuarios();
  }

  if (validando || !permitido) {
    return (
      <main className="p-6">
        <div className="bg-white rounded-xl border shadow p-6 text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-300 border-t-[#0b315f]" />
          <p className="font-bold text-[#0b315f]">Validando permisos...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-black text-[#0b315f]">
          Gestión de Usuarios
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Administra usuarios, roles, estado y permisos del ERP.
        </p>
      </div>

      <section className="bg-white rounded-2xl shadow border border-gray-100 p-5">
        <h2 className="text-xl font-black text-[#0b315f] mb-4">
          Crear nuevo usuario
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <input
            type="text"
            placeholder="Nombre"
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            className="border border-gray-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-[#0b315f]"
          />

          <input
            type="email"
            placeholder="Correo"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="border border-gray-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-[#0b315f]"
          />

          <input
            type="password"
            placeholder="Contraseña"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="border border-gray-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-[#0b315f]"
          />

          <select
            value={form.rol}
            onChange={(e) => setForm({ ...form, rol: e.target.value })}
            className="border border-gray-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-[#0b315f]"
          >
            <option value="operador">Operador</option>
            <option value="admin">Administrador</option>
          </select>

          <button
            onClick={crearUsuario}
            disabled={creando}
            className="bg-[#0b315f] hover:bg-[#08284f] text-white rounded-xl font-bold disabled:opacity-60"
          >
            {creando ? "Creando..." : "Crear usuario"}
          </button>
        </div>
      </section>

      <section className="bg-white rounded-2xl shadow border border-gray-100 overflow-hidden">
        <div className="p-5 border-b flex items-center justify-between">
          <div>
            <h2 className="text-xl font-black text-[#0b315f]">
              Usuarios registrados
            </h2>
            <p className="text-sm text-gray-500">
              {usuarios.length} usuario(s) encontrados
            </p>
          </div>

          <button
            onClick={cargarUsuarios}
            className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold text-sm"
          >
            Actualizar
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center">
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-300 border-t-[#0b315f]" />
            <p className="font-bold text-[#0b315f]">Cargando usuarios...</p>
          </div>
        ) : usuarios.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No hay usuarios registrados.
          </div>
        ) : (
          <div className="divide-y">
            {usuarios.map((user) => (
              <div key={user.id} className="p-5 space-y-4">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-black text-gray-900">
                      {user.nombre}
                    </h3>
                    <p className="text-sm text-gray-500">{user.email}</p>

                    <div className="flex gap-2 mt-2">
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-black ${
                          user.rol === "admin"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-blue-100 text-blue-700"
                        }`}
                      >
                        {user.rol === "admin" ? "Administrador" : "Operador"}
                      </span>

                      <span
                        className={`px-3 py-1 rounded-full text-xs font-black ${
                          user.activo === false
                            ? "bg-red-100 text-red-700"
                            : "bg-green-100 text-green-700"
                        }`}
                      >
                        {user.activo === false ? "Inactivo" : "Activo"}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <select
                      value={user.rol}
                      onChange={(e) => cambiarRol(user, e.target.value)}
                      className="border border-gray-300 rounded-xl px-3 py-2 text-sm"
                    >
                      <option value="operador">Operador</option>
                      <option value="admin">Administrador</option>
                    </select>

                    <button
                      onClick={() => cambiarActivo(user)}
                      className={`px-4 py-2 rounded-xl text-sm font-bold text-white ${
                        user.activo === false
                          ? "bg-green-600 hover:bg-green-700"
                          : "bg-red-600 hover:bg-red-700"
                      }`}
                    >
                      {user.activo === false ? "Activar" : "Desactivar"}
                    </button>

                    <button
                      onClick={() => guardarPermisos(user.id)}
                      className="px-4 py-2 rounded-xl text-sm font-bold bg-[#0b315f] hover:bg-[#08284f] text-white"
                    >
                      Guardar permisos
                    </button>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-2xl p-4">
                  <p className="text-sm font-black text-[#0b315f] mb-3">
                    Permisos por módulo
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
                    {MODULOS.map((modulo) => (
                      <label
                        key={modulo}
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2 cursor-pointer transition ${
                          permisos[user.id]?.[modulo]
                            ? "bg-blue-50 border-blue-300 text-[#0b315f]"
                            : "bg-white border-gray-200 text-gray-600"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={!!permisos[user.id]?.[modulo]}
                          onChange={() => togglePermiso(user.id, modulo)}
                          className="h-4 w-4"
                        />
                        <span className="text-sm font-bold">
                          {nombresModulo[modulo] || modulo}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}