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

// DEBE reflejar los `modulo` de `menuGrupos` en app/layout.tsx: esta lista es la única
// forma de otorgar permisos, y lo que no aparece aquí no tiene checkbox, así que ningún
// no-admin puede recibirlo por más que la página exista y esté en el menú.
// Antes faltaban 12 módulos (comunicados, despachador, monitoreo, pasajeros, multas,
// tarifas, finanzas, liquidaciones, contabilidad, ordenes-compra, configuracion, ajustes)
// y sobraban 4 que ningún gate consulta: calendario, tercerizadas, documentos-vehiculares
// y reservas (verificado con grep sobre menuGrupos, usePermiso y verificarUsuarioApi).
const GRUPOS_MODULOS = [
  { label: "General",      icono: "🏠", modulos: ["dashboard"] },
  { label: "Comercial",    icono: "📋", modulos: ["cotizaciones", "tarifas", "clientes"] },
  { label: "CRM",          icono: "💬", modulos: ["crm", "radar-ia"] },
  { label: "Operaciones",  icono: "🚌", modulos: ["despachador", "programacion", "seguimiento", "monitoreo", "pasajeros", "comunicados", "multas", "incidencias"] },
  { label: "Flota",        icono: "🚗", modulos: ["vehiculos", "mantenimiento", "neumaticos", "combustible", "seguros"] },
  { label: "Personal",     icono: "👷", modulos: ["conductores", "personal-administrativo"] },
  { label: "Proveedores",  icono: "🤝", modulos: ["proveedores", "ordenes-compra"] },
  { label: "Finanzas",     icono: "💰", modulos: ["liquidaciones", "finanzas", "facturacion", "gastos"] },
  { label: "Contabilidad", icono: "🧮", modulos: ["contabilidad"] },
  { label: "Documentos",   icono: "📁", modulos: ["documentos", "vencimientos"] },
  { label: "Sistema",      icono: "⚙️", modulos: ["reportes", "configuracion", "ajustes", "usuarios"] },
];

const MODULOS = GRUPOS_MODULOS.flatMap((g) => g.modulos);

const nombresModulo: Record<string, string> = {
  dashboard: "Dashboard",
  cotizaciones: "Cotizaciones", tarifas: "Tarifas", clientes: "Clientes",
  crm: "CRM", "radar-ia": "Radar IA",
  despachador: "Despachador", programacion: "Programación", seguimiento: "Seguimiento",
  monitoreo: "Monitoreo", pasajeros: "Pasajeros", comunicados: "Comunicados",
  multas: "Multas", incidencias: "Incidencias",
  vehiculos: "Vehículos", mantenimiento: "Mantenimiento",
  neumaticos: "Neumáticos", combustible: "Combustible", seguros: "Seguros",
  conductores: "Conductores", "personal-administrativo": "Personal Adm.",
  proveedores: "Proveedores", "ordenes-compra": "Órdenes de Compra",
  liquidaciones: "Liquidaciones", finanzas: "Finanzas",
  facturacion: "Facturación", gastos: "Gastos",
  contabilidad: "Contabilidad",
  documentos: "Documentos", vencimientos: "Vencimientos",
  reportes: "Reportes", configuracion: "Configuración", ajustes: "Costos", usuarios: "Usuarios",
};

function iniciales(nombre: string) {
  const p = nombre.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "?";
  if (p.length === 1) return p[0][0].toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

// ── Modal: Confirmar con contraseña ──────────────────────────────────────────
function ModalConfirmPass({
  titulo, descripcion, labelAccion, colorAccion,
  onConfirmar, onCancelar,
}: {
  titulo: string; descripcion: string; labelAccion: string; colorAccion: string;
  onConfirmar: (pass: string) => Promise<string | null>;
  onCancelar: () => void;
}) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [cargando, setCargando] = useState(false);

  const intentar = async () => {
    if (!pass) { setErr("Ingresa tu contraseña"); return; }
    setCargando(true); setErr("");
    const error = await onConfirmar(pass);
    setCargando(false);
    if (error) setErr(error);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
        <h3 className="text-lg font-black text-gray-800 mb-1">{titulo}</h3>
        <p className="text-sm text-gray-500 mb-4">{descripcion}</p>
        <div className="mb-4">
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Tu contraseña de administrador</label>
          <input
            type="password" value={pass} autoFocus
            onChange={(e) => { setPass(e.target.value); setErr(""); }}
            onKeyDown={(e) => e.key === "Enter" && intentar()}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
            placeholder="••••••••"
          />
          {err && <p className="text-xs text-red-600 mt-1.5 font-medium">⚠️ {err}</p>}
        </div>
        <div className="flex gap-2">
          <button onClick={onCancelar} className="flex-1 py-2.5 rounded-xl text-sm font-bold border hover:bg-gray-50 text-gray-700">Cancelar</button>
          <button onClick={intentar} disabled={cargando}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50"
            style={{ background: colorAccion }}>
            {cargando ? "Procesando..." : labelAccion}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal: Cambiar contraseña ─────────────────────────────────────────────────
function ModalCambiaClave({
  user, onCerrar,
}: {
  user: Usuario;
  onCerrar: () => void;
}) {
  const [nueva, setNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  const [cargando, setCargando] = useState(false);

  const guardar = async () => {
    setErr("");
    if (nueva.length < 6) { setErr("Mínimo 6 caracteres"); return; }
    if (nueva !== confirmar) { setErr("Las contraseñas no coinciden"); return; }
    setCargando(true);
    const token = await getToken();
    const res = await fetch("/api/admin-usuario", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: user.id, newPassword: nueva }),
    });
    const data = await res.json();
    setCargando(false);
    if (!res.ok) { setErr(data.error || "Error al cambiar contraseña"); return; }
    setOk(true);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
        <h3 className="text-lg font-black text-gray-800 mb-1">🔑 Cambiar contraseña</h3>
        <p className="text-sm text-gray-500 mb-4">Usuario: <b>{user.nombre}</b></p>
        {ok ? (
          <div className="text-center py-4">
            <p className="text-3xl mb-2">✅</p>
            <p className="font-bold text-green-700">Contraseña actualizada correctamente</p>
            <button onClick={onCerrar} className="mt-4 px-6 py-2.5 rounded-xl text-sm font-bold border hover:bg-gray-50 text-gray-700">Cerrar</button>
          </div>
        ) : (
          <>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Nueva contraseña</label>
                <input type="password" value={nueva} autoFocus
                  onChange={(e) => { setNueva(e.target.value); setErr(""); }}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
                  placeholder="Mínimo 6 caracteres" />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Confirmar contraseña</label>
                <input type="password" value={confirmar}
                  onChange={(e) => { setConfirmar(e.target.value); setErr(""); }}
                  onKeyDown={(e) => e.key === "Enter" && guardar()}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
                  placeholder="Repetir contraseña" />
              </div>
            </div>
            {err && <p className="text-xs text-red-600 mb-3 font-medium">⚠️ {err}</p>}
            <div className="flex gap-2">
              <button onClick={onCerrar} className="flex-1 py-2.5 rounded-xl text-sm font-bold border hover:bg-gray-50 text-gray-700">Cancelar</button>
              <button onClick={guardar} disabled={cargando}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50"
                style={{ background: "#0b315f" }}>
                {cargando ? "Guardando..." : "✅ Cambiar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────
export default function UsuariosPage() {
  const { validando, permitido } = usePermiso("usuarios");

  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [permisos, setPermisos] = useState<Record<string, Record<string, boolean>>>({});
  const [loading, setLoading] = useState(false);
  const [creando, setCreando] = useState(false);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [errForm, setErrForm] = useState("");

  // Modales
  const [modalEliminar, setModalEliminar] = useState<Usuario | null>(null);
  const [modalClave, setModalClave] = useState<Usuario | null>(null);

  const [form, setForm] = useState({ nombre: "", email: "", password: "", rol: "operador" });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setCurrentUserId(session.user.id);
    });
    cargarUsuarios();
  }, []);

  async function cargarUsuarios() {
    setLoading(true);
    const { data } = await supabase.from("usuarios").select("*").order("created_at", { ascending: false });
    setUsuarios(data || []);
    await cargarPermisos(data || []);
    setLoading(false);
  }

  async function cargarPermisos(lista: Usuario[]) {
    const { data } = await supabase.from("permisos_usuario").select("usuario_id, modulo, permitido");
    const mapa: Record<string, Record<string, boolean>> = {};
    lista.forEach((u) => { mapa[u.id] = {}; MODULOS.forEach((m) => { mapa[u.id][m] = false; }); });
    (data as Permiso[] || []).forEach((p) => { if (mapa[p.usuario_id]) mapa[p.usuario_id][p.modulo] = p.permitido; });
    setPermisos(mapa);
  }

  async function crearUsuario() {
    setErrForm("");
    if (!form.nombre.trim() || !form.email.trim() || !form.password.trim()) {
      setErrForm("Completa nombre, correo y contraseña"); return;
    }
    if (form.password.length < 6) { setErrForm("La contraseña debe tener mínimo 6 caracteres"); return; }
    setCreando(true);
    const token = await getToken();
    if (!token) { setErrForm("Sesión no válida"); setCreando(false); return; }
    const res = await fetch("/api/crear-usuario", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(form),
    });
    const result = await res.json();
    if (!res.ok) { setErrForm(result.error || "No se pudo crear usuario"); setCreando(false); return; }
    setForm({ nombre: "", email: "", password: "", rol: "operador" });
    setMostrarForm(false);
    setCreando(false);
    cargarUsuarios();
  }

  function togglePermiso(userId: string, modulo: string) {
    setPermisos((prev) => ({ ...prev, [userId]: { ...prev[userId], [modulo]: !prev[userId]?.[modulo] } }));
  }

  function toggleGrupo(userId: string, modulosGrupo: string[], valor: boolean) {
    setPermisos((prev) => {
      const next = { ...prev[userId] };
      modulosGrupo.forEach((m) => { next[m] = valor; });
      return { ...prev, [userId]: next };
    });
  }

  async function guardarPermisos(userId: string) {
    const permisosUsuario = permisos[userId] || {};
    const inserts = MODULOS.map((modulo) => ({ usuario_id: userId, modulo, permitido: !!permisosUsuario[modulo] }));
    const { error } = await supabase.from("permisos_usuario").upsert(inserts, { onConflict: "usuario_id,modulo" });
    if (!error) { setSavedId(userId); setTimeout(() => setSavedId(null), 2500); }
    await cargarUsuarios();
  }

  async function cambiarActivo(user: Usuario) {
    await supabase.from("usuarios").update({ activo: user.activo === false }).eq("id", user.id);
    cargarUsuarios();
  }

  async function cambiarRol(user: Usuario, rol: string) {
    await supabase.from("usuarios").update({ rol }).eq("id", user.id);
    cargarUsuarios();
  }

  async function eliminarUsuario(user: Usuario, pass: string): Promise<string | null> {
    // Verificar contraseña del admin
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.email) return "No hay sesión activa";
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: session.user.email, password: pass,
    });
    if (authErr) return "Contraseña incorrecta";

    const token = session.access_token;
    const res = await fetch("/api/admin-usuario", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: user.id }),
    });
    const data = await res.json();
    if (!res.ok) return data.error || "Error al eliminar";
    setModalEliminar(null);
    cargarUsuarios();
    return null;
  }

  const admins     = usuarios.filter((u) => u.rol === "admin").length;
  const operadores = usuarios.filter((u) => u.rol !== "admin").length;
  const inactivos  = usuarios.filter((u) => u.activo === false).length;

  if (validando || !permitido) {
    return (
      <main className="p-6">
        <div className="bg-white rounded-xl border p-8 text-center">
          <div className="mx-auto mb-3 h-9 w-9 animate-spin rounded-full border-4 border-gray-200 border-t-[#0b315f]" />
          <p className="font-bold text-[#0b315f]">Validando permisos...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Modales */}
      {modalEliminar && (
        <ModalConfirmPass
          titulo={`🗑️ Eliminar a ${modalEliminar.nombre}`}
          descripcion="Esta acción eliminará permanentemente la cuenta del usuario. Ingresa tu contraseña para confirmar."
          labelAccion="🗑️ Eliminar usuario"
          colorAccion="#dc2626"
          onConfirmar={(pass) => eliminarUsuario(modalEliminar, pass)}
          onCancelar={() => setModalEliminar(null)}
        />
      )}
      {modalClave && (
        <ModalCambiaClave user={modalClave} onCerrar={() => { setModalClave(null); cargarUsuarios(); }} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black text-[#0b315f]">Gestión de Usuarios</h1>
          <p className="text-sm text-gray-500 mt-0.5">Administra roles, estado y permisos del ERP</p>
        </div>
        <button
          onClick={() => { setMostrarForm(!mostrarForm); setErrForm(""); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white shadow-sm"
          style={{ background: "#0b315f" }}
        >
          {mostrarForm ? "✕ Cancelar" : "+ Nuevo usuario"}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total usuarios",  valor: usuarios.length, color: "#0b315f", bg: "#eef3f8", icono: "👥" },
          { label: "Administradores", valor: admins,          color: "#854d0e", bg: "#fef9c3", icono: "👑" },
          { label: "Operadores",      valor: operadores,      color: "#1e40af", bg: "#eff6ff", icono: "👤" },
          { label: "Inactivos",       valor: inactivos,       color: "#991b1b", bg: "#fee2e2", icono: "🔒" },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl p-4 flex items-center gap-3" style={{ background: s.bg }}>
            <span className="text-2xl">{s.icono}</span>
            <div>
              <p className="text-2xl font-black" style={{ color: s.color }}>{s.valor}</p>
              <p className="text-xs font-bold text-gray-500">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Formulario nuevo usuario */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-base font-black text-[#0b315f] mb-4">Crear nuevo usuario</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Nombre completo *</label>
              <input type="text" placeholder="Ej: Juan Pérez García" value={form.nombre}
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]" />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Correo electrónico *</label>
              <input type="email" placeholder="correo@empresa.com" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]" />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Contraseña *</label>
              <input type="password" placeholder="Mínimo 6 caracteres" value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && crearUsuario()}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]" />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Rol</label>
              <select value={form.rol} onChange={(e) => setForm({ ...form, rol: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]">
                <option value="operador">Operador</option>
                <option value="admin">Administrador</option>
              </select>
            </div>
          </div>
          {errForm && <p className="text-xs text-red-600 font-medium mb-3">⚠️ {errForm}</p>}
          <div className="flex gap-2">
            <button onClick={crearUsuario} disabled={creando}
              className="px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50"
              style={{ background: "#0b315f" }}>
              {creando ? "Creando..." : "✅ Crear usuario"}
            </button>
            <button onClick={() => { setMostrarForm(false); setErrForm(""); }}
              className="px-5 py-2.5 rounded-xl text-sm font-bold border hover:bg-gray-50 text-gray-700">
              Cancelar
            </button>
          </div>
        </section>
      )}

      {/* Lista de usuarios */}
      <section className="space-y-3">
        {loading ? (
          <div className="bg-white rounded-2xl border p-10 text-center">
            <div className="mx-auto mb-3 h-9 w-9 animate-spin rounded-full border-4 border-gray-200 border-t-[#0b315f]" />
            <p className="font-bold text-[#0b315f]">Cargando usuarios...</p>
          </div>
        ) : usuarios.length === 0 ? (
          <div className="bg-white rounded-2xl border p-10 text-center text-gray-400">
            <p className="text-3xl mb-2">👥</p><p className="font-bold">No hay usuarios registrados</p>
          </div>
        ) : usuarios.map((user) => {
          const esAdmin  = user.rol === "admin";
          const esActivo = user.activo !== false;
          const esTu     = user.id === currentUserId;
          const permisoCount = Object.values(permisos[user.id] || {}).filter(Boolean).length;
          const isExpanded = expandedId === user.id;
          const isSaved    = savedId === user.id;

          return (
            <div key={user.id}
              className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${!esActivo ? "opacity-70" : ""}`}
              style={{ borderColor: esTu ? "#0b315f" : "#e5e7eb" }}>

              {/* Cabecera del usuario */}
              <div className="p-4 flex items-start gap-4 flex-wrap">
                {/* Avatar */}
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white text-lg font-black flex-shrink-0"
                  style={{ background: esAdmin ? "#854d0e" : "#0b315f" }}>
                  {iniciales(user.nombre)}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-black text-gray-900 truncate">{user.nombre}</h3>
                    {esTu && <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-[#0b315f] text-white">👤 Tú</span>}
                  </div>
                  <p className="text-sm text-gray-500 truncate">{user.email}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-black ${esAdmin ? "bg-yellow-100 text-yellow-800" : "bg-blue-100 text-blue-800"}`}>
                      {esAdmin ? "👑 Administrador" : "👤 Operador"}
                    </span>
                    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-black ${esActivo ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                      {esActivo ? "● Activo" : "● Inactivo"}
                    </span>
                    {!esAdmin && (
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-500">
                        {permisoCount}/{MODULOS.length} módulos
                      </span>
                    )}
                  </div>
                </div>

                {/* Acciones principales */}
                <div className="flex items-center gap-2 flex-wrap">
                  <select value={user.rol} onChange={(e) => cambiarRol(user, e.target.value)}
                    className="border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                    style={{ color: esAdmin ? "#854d0e" : "#1e40af" }}>
                    <option value="operador">Operador</option>
                    <option value="admin">Administrador</option>
                  </select>

                  <button onClick={() => cambiarActivo(user)}
                    className="px-3 py-2 rounded-xl text-xs font-bold text-white hover:opacity-90"
                    style={{ background: esActivo ? "#dc2626" : "#16a34a" }}>
                    {esActivo ? "Desactivar" : "Activar"}
                  </button>

                  <button onClick={() => setExpandedId(isExpanded ? null : user.id)}
                    className="px-3 py-2 rounded-xl text-xs font-bold border hover:bg-gray-50 text-gray-600 flex items-center gap-1.5">
                    ⚙️ Permisos
                    <span className={`transition-transform inline-block ${isExpanded ? "rotate-180" : ""}`}>▾</span>
                  </button>
                </div>
              </div>

              {/* Barra de acciones admin (eliminar + cambiar clave) */}
              {!esTu && (
                <div className="px-4 pb-3 flex gap-2">
                  <button
                    onClick={() => setModalClave(user)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border hover:bg-blue-50 transition-colors"
                    style={{ color: "#1e40af", borderColor: "#bfdbfe" }}>
                    🔑 Cambiar contraseña
                  </button>
                  <button
                    onClick={() => setModalEliminar(user)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border hover:bg-red-50 transition-colors"
                    style={{ color: "#dc2626", borderColor: "#fca5a5" }}>
                    🗑️ Eliminar usuario
                  </button>
                </div>
              )}

              {/* Panel de permisos colapsable */}
              {isExpanded && (
                <div className="border-t border-gray-100 p-4" style={{ background: "#f8fafc" }}>
                  {esAdmin ? (
                    <div className="flex items-center gap-3 py-3 px-4 rounded-xl bg-yellow-50 border border-yellow-200">
                      <span className="text-2xl">👑</span>
                      <div>
                        <p className="text-sm font-black text-yellow-800">Acceso total de administrador</p>
                        <p className="text-xs text-yellow-700">Los administradores tienen acceso a todos los módulos automáticamente.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-black text-gray-500 uppercase tracking-wide">Permisos por módulo</p>
                        <div className="flex gap-2">
                          <button onClick={() => toggleGrupo(user.id, MODULOS, true)}
                            className="text-[11px] font-bold px-2.5 py-1 rounded-lg bg-[#0b315f] text-white hover:opacity-90">
                            Todos
                          </button>
                          <button onClick={() => toggleGrupo(user.id, MODULOS, false)}
                            className="text-[11px] font-bold px-2.5 py-1 rounded-lg border hover:bg-gray-100 text-gray-600">
                            Ninguno
                          </button>
                        </div>
                      </div>

                      {GRUPOS_MODULOS.map((grupo) => {
                        const todosActivos = grupo.modulos.every((m) => permisos[user.id]?.[m]);
                        return (
                          <div key={grupo.label} className="bg-white rounded-xl border border-gray-100 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-black text-gray-600">{grupo.icono} {grupo.label}</span>
                              <button onClick={() => toggleGrupo(user.id, grupo.modulos, !todosActivos)}
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-lg ${todosActivos ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                                {todosActivos ? "✓ Todo" : "Activar todo"}
                              </button>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                              {grupo.modulos.map((modulo) => (
                                <label key={modulo}
                                  className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 cursor-pointer text-xs font-bold transition-all border ${permisos[user.id]?.[modulo] ? "bg-blue-50 border-blue-200 text-[#0b315f]" : "bg-gray-50 border-gray-100 text-gray-400"}`}>
                                  <input type="checkbox"
                                    checked={!!permisos[user.id]?.[modulo]}
                                    onChange={() => togglePermiso(user.id, modulo)}
                                    className="h-3.5 w-3.5 rounded" />
                                  {nombresModulo[modulo] || modulo}
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!esAdmin && (
                    <div className="mt-3 flex items-center gap-3">
                      <button onClick={() => guardarPermisos(user.id)}
                        className="px-4 py-2 rounded-xl text-sm font-bold text-white"
                        style={{ background: "#0b315f" }}>
                        💾 Guardar permisos
                      </button>
                      {isSaved && <span className="text-sm font-bold text-green-600">✅ Permisos guardados</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
