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
    const { data } = await supabase
      .from("permisos_usuario")
      .select("*");

    const mapa: any = {};

    listaUsuarios.forEach((u) => {
      mapa[u.id] = {};
      MODULOS.forEach((m) => {
        mapa[u.id][m] = false;
      });
    });

    // 🔥 CORRECCIÓN AQUÍ
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
      <h1 className="text-3xl font-bold">Gestión de Usuarios</h1>

      {usuarios.map((user) => (
        <div key={user.id}>
          {user.nombre}
        </div>
      ))}
    </main>
  );
}