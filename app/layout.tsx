"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import "./globals.css";

const menu = [
  { href: "/dashboard", label: "Dashboard", sub: "Panel principal", icon: "🏠", modulo: "dashboard" },
  { href: "/reservas", label: "Reservas", sub: "Servicios", icon: "🎫", modulo: "reservas" },
  { href: "/cotizaciones", label: "Cotizaciones", sub: "Precios y rutas", icon: "📄", modulo: "cotizaciones" },
  { href: "/clientes", label: "Clientes", sub: "Base comercial", icon: "👥", modulo: "clientes" },
  { href: "/proveedores", label: "Proveedores", sub: "Tercerización", icon: "🏢", modulo: "proveedores" },
  { href: "/conductores", label: "Conductores", sub: "Choferes", icon: "🧑‍✈️", modulo: "conductores" },
  { href: "/vehiculos", label: "Vehículos", sub: "Flota", icon: "🚌", modulo: "vehiculos" },
  { href: "/combustible", label: "Combustible", sub: "Consumo", icon: "⛽", modulo: "combustible" },
  { href: "/mantenimiento", label: "Mantenimiento", sub: "Técnico", icon: "🔧", modulo: "mantenimiento" },
  { href: "/neumaticos", label: "Neumáticos", sub: "Vida útil", icon: "🛞", modulo: "neumaticos" },
  { href: "/documentos", label: "Documentos", sub: "SST / contratos", icon: "📁", modulo: "documentos" },
  { href: "/facturacion", label: "Facturación", sub: "SUNAT / pagos", icon: "🧾", modulo: "facturacion" },
  { href: "/gastos", label: "Gastos", sub: "Egresos", icon: "💸", modulo: "gastos" },
  { href: "/seguros", label: "Seguros", sub: "Pólizas", icon: "🛡️", modulo: "seguros" },
  { href: "/reportes", label: "Reportes", sub: "Indicadores", icon: "📊", modulo: "reportes" },
  { href: "/usuarios", label: "Usuarios", sub: "Permisos", icon: "🔐", modulo: "usuarios" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const esLogin = pathname === "/login";

  const [emailUsuario, setEmailUsuario] = useState("");
  const [nombreUsuario, setNombreUsuario] = useState("Usuario");
  const [rolUsuario, setRolUsuario] = useState("operador");
  const [permisos, setPermisos] = useState<string[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    async function cargarSesionPermisos() {
      if (esLogin) {
        setCargando(false);
        return;
      }

      setCargando(true);

      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        router.replace("/login");
        return;
      }

      setEmailUsuario(session.user.email || "");

      const { data: perfil } = await supabase
        .from("usuarios")
        .select("nombre, rol, activo")
        .eq("id", session.user.id)
        .maybeSingle();

      if (!perfil || perfil.activo === false) {
        await supabase.auth.signOut();
        router.replace("/login");
        return;
      }

      setNombreUsuario(perfil.nombre || "Usuario");
      setRolUsuario(perfil.rol || "operador");

      const { data: permisosData } = await supabase
        .from("permisos_usuario")
        .select("modulo")
        .eq("usuario_id", session.user.id)
        .eq("permitido", true);

      let listaPermisos = permisosData?.map((p) => p.modulo) || [];

      if (perfil.rol === "admin" && listaPermisos.length === 0) {
        listaPermisos = menu.map((item) => item.modulo);
      }

      setPermisos(listaPermisos);

      const rutaActual = menu.find(
        (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
      );

      if (rutaActual && !listaPermisos.includes(rutaActual.modulo)) {
        router.replace("/dashboard");
        return;
      }

      setCargando(false);
    }

    cargarSesionPermisos();
  }, [pathname, esLogin, router]);

  async function cerrarSesion() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const menuVisible = menu.filter((item) => permisos.includes(item.modulo));

  return (
    <html lang="es">
      <body>
        {esLogin ? (
          <div className="min-h-screen flex items-center justify-center bg-[#eef3f8] px-4">
            <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl">
              {children}
            </div>
          </div>
        ) : cargando ? (
          <div className="min-h-screen flex items-center justify-center bg-[#eef3f8]">
            <div className="text-center">
              <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-gray-300 border-t-[#0b315f]" />
              <p className="font-bold text-[#0b315f]">Validando permisos...</p>
            </div>
          </div>
        ) : (
          <div className="min-h-screen flex bg-[#eef3f8]">
            <aside className="w-64 bg-gradient-to-b from-[#0b315f] via-[#08284f] to-[#03162f] text-white flex flex-col shadow-2xl">
              <div className="p-4 border-b border-white/10">
                <div className="bg-white rounded-2xl p-3 shadow-lg">
                  <img src="/logoafa.png" alt="AFA Transportes" className="w-full" />
                </div>

                <div className="mt-4 bg-white/10 rounded-2xl px-4 py-3">
                  <p className="font-bold text-base">Sistema de Gestión</p>
                  <p className="text-xs text-blue-200">ERP Transporte</p>
                </div>
              </div>

              <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto">
                {menuVisible.map((item) => {
                  const activo = pathname === item.href || pathname.startsWith(`${item.href}/`);

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                        activo
                          ? "bg-gradient-to-r from-[#2f8ee9] to-[#1262bd]"
                          : "hover:bg-white/10"
                      }`}
                    >
                      <div className="w-9 h-9 flex items-center justify-center">
                        {item.icon}
                      </div>

                      <div>
                        <p className="font-bold text-sm">{item.label}</p>
                        <p className="text-[11px] text-blue-200">{item.sub}</p>
                      </div>
                    </Link>
                  );
                })}
              </nav>

              <div className="p-4 border-t border-white/10 bg-black/10">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-white text-[#0b315f] flex items-center justify-center font-black">
                    {nombreUsuario.charAt(0).toUpperCase()}
                  </div>

                  <div className="min-w-0">
                    <p className="font-bold text-sm">{nombreUsuario}</p>
                    <p className="text-[11px] text-blue-200 truncate">{emailUsuario}</p>
                    <p className="text-[11px] font-bold text-yellow-300 uppercase">
                      {rolUsuario === "admin" ? "Administrador" : "Operador"}
                    </p>
                  </div>
                </div>

                <button
                  onClick={cerrarSesion}
                  className="w-full bg-red-600 hover:bg-red-700 text-white text-sm font-bold py-2 rounded-xl"
                >
                  Cerrar sesión
                </button>
              </div>
            </aside>

            <main className="flex-1 overflow-y-auto p-6">{children}</main>
          </div>
        )}
      </body>
    </html>
  );
}