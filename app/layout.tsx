"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import "./globals.css";

const menuGrupos = [
  {
    grupo: "Principal",
    items: [
      { href: "/dashboard", label: "Dashboard", sub: "Panel principal", icon: "🏠", modulo: "dashboard" },
      { href: "/calendario", label: "Calendario", sub: "Servicios del día", icon: "📅", modulo: "dashboard" },
    ],
  },
  {
    grupo: "Comercial",
    items: [
      { href: "/cotizaciones", label: "Cotizaciones", sub: "Precios y rutas", icon: "📄", modulo: "cotizaciones" },
      { href: "/reservas", label: "Reservas", sub: "Servicios", icon: "🎫", modulo: "reservas" },
      { href: "/clientes", label: "Clientes", sub: "Base comercial", icon: "👥", modulo: "clientes" },
    ],
  },
  {
    grupo: "Operaciones",
    items: [
      { href: "/programacion", label: "Programación", sub: "Core del sistema", icon: "🗓️", modulo: "programacion" },
      { href: "/seguimiento", label: "Seguimiento", sub: "Estado en tiempo real", icon: "🔍", modulo: "seguimiento" },
      { href: "/monitoreo", label: "Monitoreo", sub: "Mapa y unidades", icon: "📡", modulo: "monitoreo" },
      { href: "/incidencias", label: "Incidencias", sub: "Eventos y alertas", icon: "⚠️", modulo: "incidencias" },
    ],
  },
  {
    grupo: "Flota",
    items: [
      { href: "/vehiculos", label: "Vehículos", sub: "Flota", icon: "🚌", modulo: "vehiculos" },
      { href: "/documentos-vehiculares", label: "Docs. Vehiculares", sub: "SOAT · CITV · MTC", icon: "📄", modulo: "vehiculos" },
      { href: "/mantenimiento", label: "Mantenimiento", sub: "Historial técnico", icon: "🔧", modulo: "mantenimiento" },
      { href: "/mantenimiento/ordenes", label: "Órdenes de Trabajo", sub: "OT · Checklist", icon: "📋", modulo: "mantenimiento" },
      { href: "/neumaticos", label: "Neumáticos", sub: "Vida útil", icon: "🛞", modulo: "neumaticos" },
      { href: "/combustible", label: "Combustible", sub: "Consumo", icon: "⛽", modulo: "combustible" },
      { href: "/seguros", label: "Seguros", sub: "Pólizas", icon: "🛡️", modulo: "seguros" },
    ],
  },
  {
    grupo: "RRHH",
    items: [
      { href: "/conductores", label: "Conductores", sub: "Choferes", icon: "🧑‍✈️", modulo: "conductores" },
      { href: "/personal-administrativo", label: "Personal Administrativo", sub: "Equipo interno", icon: "👔", modulo: "personal-administrativo" },
    ],
  },
  {
    grupo: "Proveedores",
    items: [
      { href: "/proveedores", label: "Proveedores", sub: "Talleres · grifos", icon: "🏢", modulo: "proveedores" },
      { href: "/tercerizadas", label: "Tercerizadas", sub: "Flota externa", icon: "🤝", modulo: "proveedores" },
    ],
  },
  {
    grupo: "Finanzas",
    items: [
      { href: "/facturacion", label: "Facturación", sub: "SUNAT / pagos", icon: "🧾", modulo: "facturacion" },
      { href: "/gastos", label: "Gastos", sub: "Egresos", icon: "💸", modulo: "gastos" },
    ],
  },
  {
    grupo: "Control",
    items: [
      { href: "/vencimientos", label: "Vencimientos", sub: "Alertas doc.", icon: "📁", modulo: "vencimientos" },
      { href: "/documentos", label: "Documentos", sub: "SST / contratos", icon: "🗂️", modulo: "documentos" },
    ],
  },
  {
    grupo: "Reportes",
    items: [
      { href: "/reportes", label: "Reportes", sub: "Indicadores", icon: "📊", modulo: "reportes" },
    ],
  },
  {
    grupo: "Sistema",
    items: [
      { href: "/usuarios", label: "Usuarios", sub: "Permisos", icon: "🔐", modulo: "usuarios" },
    ],
  },
];

const menu = menuGrupos.flatMap((g) => g.items);

function GrupoMenu({
  grupo,
  items,
  pathname,
  permisos,
}: {
  grupo: string;
  items: typeof menu;
  pathname: string;
  permisos: string[];
}) {
  const itemsVisibles = items.filter((item) => permisos.includes(item.modulo));
  if (itemsVisibles.length === 0) return null;

  const grupoActivo = itemsVisibles.some(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  );

  const [abierto, setAbierto] = useState(grupoActivo || grupo === "Principal");

  useEffect(() => {
    if (grupoActivo) setAbierto(true);
  }, [grupoActivo]);

  return (
    <div className="mb-1">
      {grupo !== "Principal" && (
        <button
          onClick={() => setAbierto((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-1.5 text-left"
        >
          <span className="text-[10px] font-bold uppercase tracking-widest text-blue-300/70">
            {grupo}
          </span>
          <span
            className="text-blue-300/50 text-xs transition-transform duration-200"
            style={{ transform: abierto ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ›
          </span>
        </button>
      )}

      {abierto && (
        <div className="space-y-0.5">
          {itemsVisibles.map((item) => {
            const activo =
              pathname === item.href || pathname.startsWith(`${item.href}/`);

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
                <div className="w-8 h-8 flex items-center justify-center text-base flex-shrink-0">
                  {item.icon}
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-sm leading-tight">{item.label}</p>
                  <p className="text-[10px] text-blue-200 truncate">{item.sub}</p>
                </div>
                {activo && (
                  <div className="ml-auto w-1.5 h-1.5 rounded-full bg-white/80 flex-shrink-0" />
                )}
              </Link>
            );
          })}
        </div>
      )}

      {grupo !== "Principal" && <div className="mt-1 border-t border-white/5" />}
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const esLogin = pathname === "/login";

  const esPublica = ["/conductor"].some(
    (r) => pathname === r || pathname.startsWith(r + "/")
  );

  const [emailUsuario, setEmailUsuario] = useState("");
  const [nombreUsuario, setNombreUsuario] = useState("Usuario");
  const [rolUsuario, setRolUsuario] = useState("operador");
  const [permisos, setPermisos] = useState<string[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    async function cargarSesionPermisos() {
      if (esLogin || esPublica) {
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
        window.location.href = "/login";
        return;
      }

      setNombreUsuario(perfil.nombre || "Usuario");
      setRolUsuario(perfil.rol || "operador");

      const { data: permisosData } = await supabase
        .from("permisos_usuario")
        .select("modulo")
        .eq("usuario_id", session.user.id)
        .eq("permitido", true);

      let listaPermisos = permisosData?.map((p: any) => p.modulo) || [];

      if (perfil.rol === "admin") {
        listaPermisos = [...new Set(menu.map((item) => item.modulo))];
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
  }, [pathname, esLogin, esPublica, router]);

  async function cerrarSesion() {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error("Error al cerrar sesión:", error);
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <html lang="es">
      <body>
        {esLogin ? (
          <div className="min-h-screen flex items-center justify-center bg-[#eef3f8] px-4">
            <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl">
              {children}
            </div>
          </div>
        ) : esPublica ? (
          <div style={{ margin: 0, padding: 0, height: "100vh" }}>
            {children}
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
                <div className="mt-3 bg-white/10 rounded-2xl px-4 py-2.5">
                  <p className="font-bold text-sm">Sistema de Gestión</p>
                  <p className="text-[11px] text-blue-200">ERP Transporte</p>
                </div>
              </div>

              <nav className="flex-1 p-3 overflow-y-auto">
                {menuGrupos.map((g) => (
                  <GrupoMenu
                    key={g.grupo}
                    grupo={g.grupo}
                    items={g.items}
                    pathname={pathname}
                    permisos={permisos}
                  />
                ))}
              </nav>

              <div className="p-4 border-t border-white/10 bg-black/10">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-white text-[#0b315f] flex items-center justify-center font-black flex-shrink-0">
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
                  className="w-full bg-red-600 hover:bg-red-700 text-white text-sm font-bold py-2 rounded-xl transition-colors"
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