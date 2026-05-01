"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import "./globals.css";

const menu = [
  { href: "/dashboard", label: "Dashboard", sub: "Panel principal", icon: "🏠" },
  { href: "/reservas", label: "Reservas", sub: "Servicios", icon: "🎫" },
  { href: "/cotizaciones", label: "Cotizaciones", sub: "Precios y rutas", icon: "📄" },
  { href: "/clientes", label: "Clientes", sub: "Base comercial", icon: "👥" },
  { href: "/proveedores", label: "Proveedores", sub: "Tercerización", icon: "🏢" },
  { href: "/conductores", label: "Conductores", sub: "Choferes", icon: "🧑‍✈️" },
  { href: "/vehiculos", label: "Vehículos", sub: "Flota", icon: "🚌" },
  { href: "/combustible", label: "Combustible", sub: "Consumo", icon: "⛽" },
  { href: "/mantenimiento", label: "Mantenimiento", sub: "Técnico", icon: "🔧" },
  { href: "/neumaticos", label: "Neumáticos", sub: "Vida útil", icon: "🛞" },
  { href: "/documentos", label: "Documentos", sub: "SST / contratos", icon: "📁" },
  { href: "/facturacion", label: "Facturación", sub: "SUNAT / pagos", icon: "🧾" },
  { href: "/gastos", label: "Gastos", sub: "Egresos", icon: "💸" },
  { href: "/seguros", label: "Seguros", sub: "Pólizas", icon: "🛡️" },
  { href: "/reportes", label: "Reportes", sub: "Indicadores", icon: "📊" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <html lang="es">
      <body>
        <div className="min-h-screen flex bg-[#eef3f8]">
          <aside className="w-64 bg-gradient-to-b from-[#0b315f] via-[#08284f] to-[#03162f] text-white flex flex-col shadow-2xl">
            <div className="p-4 border-b border-white/10">
              <div className="bg-white rounded-2xl p-3 shadow-lg">
                <img
                  src="/logoafa.png"
                  alt="AFA Transportes"
                  className="w-full h-auto object-contain"
                />
              </div>

              <div className="mt-4 bg-white/10 rounded-2xl px-4 py-3 shadow-inner border border-white/10">
                <p className="font-bold text-base">Sistema de Gestión</p>
                <p className="text-xs text-blue-200">ERP Transporte</p>
              </div>
            </div>

            <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto">
              {menu.map((item) => {
                const activo = pathname.startsWith(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                      activo
                        ? "bg-gradient-to-r from-[#2f8ee9] to-[#1262bd] shadow-lg"
                        : "hover:bg-white/10"
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg ${
                        activo ? "bg-white/20" : "bg-white/10"
                      }`}
                    >
                      {item.icon}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm leading-tight truncate">
                        {item.label}
                      </p>
                      <p className="text-[11px] text-blue-200 truncate">
                        {item.sub}
                      </p>
                    </div>

                    {activo && <span className="text-xl">›</span>}
                  </Link>
                );
              })}
            </nav>

            <div className="p-4 border-t border-white/10 bg-black/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white text-[#0b315f] flex items-center justify-center font-black">
                  A
                </div>

                <div className="min-w-0">
                  <p className="font-bold text-sm">Administración</p>
                  <p className="text-[11px] text-blue-200 truncate">
                    administracion@afatoursperu.com
                  </p>
                </div>
              </div>
            </div>
          </aside>

          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}