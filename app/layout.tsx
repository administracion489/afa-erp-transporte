"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import "./globals.css";

// ─── Iconos SVG inline (sin dependencias externas) ─────────────────────────
type IconProps = { size?: number; strokeWidth?: number; className?: string };

const Ic = {
  Dashboard: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
    </svg>
  ),
  Calendar: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  ),
  FileText: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  ),
  Users: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  CalendarRange: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h2v4H8z"/><path d="M14 14h2v4h-2z"/>
    </svg>
  ),
  Search: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  Radio: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/>
    </svg>
  ),
  AlertTriangle: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  Bus: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/>
    </svg>
  ),
  FileCheck: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/>
    </svg>
  ),
  Wrench: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
  ),
  Clipboard: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  ),
  Circle: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ),
  Fuel: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="3" y1="22" x2="15" y2="22"/><line x1="4" y1="9" x2="14" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>
    </svg>
  ),
  Shield: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  UserCheck: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>
    </svg>
  ),
  Briefcase: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
    </svg>
  ),
  Building: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18"/><path d="M9 21V9"/>
    </svg>
  ),
  Handshake: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20.42 4.58a5.4 5.4 0 0 0-7.65 0l-.77.78-.77-.78a5.4 5.4 0 0 0-7.65 0C1.46 6.7 1.33 10.28 4 13l8 8 8-8c2.67-2.72 2.54-6.3.42-8.42z"/>
    </svg>
  ),
  Receipt: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/>
    </svg>
  ),
  TrendingDown: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>
    </svg>
  ),
  Folder: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  Archive: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>
    </svg>
  ),
  DollarSign: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  ),
  BarChart: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
    </svg>
  ),
  Lock: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  ),
  Settings: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
  Calculator: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="2" width="16" height="20" rx="2"/>
      <line x1="8" y1="6" x2="16" y2="6"/>
      <line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/>
      <line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/>
      <line x1="8" y1="18" x2="10" y2="18"/><line x1="14" y1="18" x2="16" y2="18"/>
    </svg>
  ),
  LogOut: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  ),
  ChevronRight: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  ),
  PanelClose: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M16 15l-3-3 3-3"/>
    </svg>
  ),
  PanelOpen: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 9l3 3-3 3"/>
    </svg>
  ),
  // ── Multas ──────────────────────────────────────────────────────────────
  Fine: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <line x1="12" y1="11" x2="12" y2="11.01"/><line x1="12" y1="14" x2="12" y2="17"/>
    </svg>
  ),
};

// ─── Tipos ─────────────────────────────────────────────────────────────────
type IconComponent = (props: IconProps) => JSX.Element;
type MenuItem = {
  href: string;
  label: string;
  sub: string;
  icon: IconComponent;
  modulo: string;
};

// ─── Menú ──────────────────────────────────────────────────────────────────
const menuGrupos: { grupo: string; items: MenuItem[] }[] = [
  {
    grupo: "Principal",
    items: [
      { href: "/dashboard", label: "Dashboard", sub: "Panel principal", icon: Ic.Dashboard, modulo: "dashboard" },
    ],
  },
  {
    grupo: "Comercial",
    items: [
      { href: "/cotizaciones", label: "Cotizaciones", sub: "Precios y rutas",      icon: Ic.FileText,   modulo: "cotizaciones" },
      { href: "/cotizador",    label: "Cotizador",    sub: "Estructura de costos", icon: Ic.Calculator, modulo: "cotizaciones" },
      { href: "/tarifario",    label: "Tarifas",      sub: "Tarifarios",           icon: Ic.DollarSign, modulo: "tarifas"      },
      { href: "/clientes",     label: "Clientes",     sub: "Base comercial",       icon: Ic.Users,      modulo: "clientes"     },
    ],
  },
  {
    grupo: "Operaciones",
    items: [
      { href: "/calendario",   label: "Calendario",   sub: "Servicios del día",     icon: Ic.Calendar,      modulo: "dashboard"    },
      { href: "/programacion", label: "Programación", sub: "Core del sistema",      icon: Ic.CalendarRange, modulo: "programacion" },
      { href: "/seguimiento",  label: "Seguimiento",  sub: "Estado en tiempo real", icon: Ic.Search,        modulo: "seguimiento"  },
      { href: "/monitoreo",    label: "Monitoreo",    sub: "Mapa y unidades",       icon: Ic.Radio,         modulo: "monitoreo"    },
      { href: "/pasajeros",    label: "Pasajeros",    sub: "Base de pasajeros",     icon: Ic.Users,         modulo: "pasajeros"    },
      { href: "/multas",       label: "Multas",       sub: "Infracciones",          icon: Ic.Fine,          modulo: "multas"       },
      { href: "/incidencias",  label: "Incidencias",  sub: "Eventos y alertas",     icon: Ic.AlertTriangle, modulo: "incidencias"  },
    ],
  },
  {
    grupo: "Flota",
    items: [
      { href: "/vehiculos",              label: "Vehículos",          sub: "Flota",              icon: Ic.Bus,       modulo: "vehiculos"    },
      { href: "/documentos-vehiculares", label: "Docs. Vehiculares",  sub: "SOAT · CITV · MTC",  icon: Ic.FileCheck, modulo: "vehiculos"    },
      { href: "/mantenimiento",          label: "Mantenimiento",      sub: "Historial técnico",   icon: Ic.Wrench,    modulo: "mantenimiento"},
      { href: "/mantenimiento/ordenes",  label: "Órdenes de Trabajo", sub: "OT · Checklist",     icon: Ic.Clipboard, modulo: "mantenimiento"},
      { href: "/neumaticos",             label: "Neumáticos",         sub: "Vida útil",           icon: Ic.Circle,    modulo: "neumaticos"   },
      { href: "/combustible",            label: "Combustible",        sub: "Consumo",             icon: Ic.Fuel,      modulo: "combustible"  },
      { href: "/seguros",                label: "Seguros",            sub: "Pólizas",             icon: Ic.Shield,    modulo: "seguros"      },
    ],
  },
  {
    grupo: "RRHH",
    items: [
      { href: "/conductores",             label: "Conductores",    sub: "Choferes",        icon: Ic.UserCheck, modulo: "conductores"            },
      { href: "/personal-administrativo", label: "Personal Adm.", sub: "Equipo interno",  icon: Ic.Briefcase, modulo: "personal-administrativo" },
    ],
  },
  {
    grupo: "Proveedores",
    items: [
      { href: "/proveedores",  label: "Proveedores",  sub: "Talleres · grifos", icon: Ic.Building,  modulo: "proveedores" },
      { href: "/tercerizadas", label: "Tercerizadas", sub: "Flota externa",     icon: Ic.Handshake, modulo: "proveedores" },
    ],
  },
  {
    grupo: "Finanzas",
    items: [
      { href: "/facturacion", label: "Facturación", sub: "SUNAT / pagos", icon: Ic.Receipt,      modulo: "facturacion" },
      { href: "/gastos",      label: "Gastos",      sub: "Egresos",       icon: Ic.TrendingDown, modulo: "gastos"      },
    ],
  },
  {
    grupo: "Control",
    items: [
      { href: "/vencimientos", label: "Vencimientos", sub: "Alertas doc.",    icon: Ic.Folder,  modulo: "vencimientos" },
      { href: "/documentos",   label: "Documentos",   sub: "SST / contratos", icon: Ic.Archive, modulo: "documentos"   },
    ],
  },
  {
    grupo: "Reportes",
    items: [
      { href: "/reportes", label: "Reportes", sub: "Indicadores", icon: Ic.BarChart, modulo: "reportes" },
    ],
  },
  {
    grupo: "Sistema",
    items: [
      { href: "/usuarios", label: "Usuarios",        sub: "Permisos",          icon: Ic.Lock,     modulo: "usuarios" },
      { href: "/ajustes",  label: "Ajuste de Costos",sub: "Flota y combustible",icon: Ic.Settings, modulo: "ajustes"  },
    ],
  },
];

const menu = menuGrupos.flatMap((g) => g.items);

// Grupos que arrancan abiertos por defecto
const GRUPOS_ABIERTOS_DEFAULT = ["Principal", "Comercial", "Operaciones", "Flota"];

// ─── Logo ───────────────────────────────────────────────────────────────────
function LogoAFA({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <div className="w-10 h-10 mx-auto rounded-xl overflow-hidden bg-[#2a5298] flex items-center justify-center shadow-lg">
        <img src="/logoafa.png" alt="AFA" className="w-9 h-9 object-contain" />
      </div>
    );
  }
  return (
    <div className="w-full bg-[#2a5298] rounded-xl px-3 py-2 shadow-lg flex items-center justify-center">
      <img src="/logoafa.png" alt="AFA Transportes" className="w-full max-h-14 object-contain" />
    </div>
  );
}

// ─── Grupo de menú ──────────────────────────────────────────────────────────
function GrupoMenu({
  grupo,
  items,
  pathname,
  permisos,
  collapsed,
}: {
  grupo: string;
  items: MenuItem[];
  pathname: string;
  permisos: string[];
  collapsed: boolean;
}) {
  const itemsVisibles = items.filter((item) => permisos.includes(item.modulo));
  if (itemsVisibles.length === 0) return null;

  const grupoActivo = itemsVisibles.some(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  );

  // Comercial, Operaciones y Flota arrancan abiertas; el resto colapsadas
  const [abierto, setAbierto] = useState(grupoActivo || GRUPOS_ABIERTOS_DEFAULT.includes(grupo));

  useEffect(() => {
    if (grupoActivo) setAbierto(true);
  }, [grupoActivo]);

  // ── Modo colapsado ───────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <div className="mb-0.5">
        {itemsVisibles.map((item) => {
          const activo = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`
                group relative flex items-center justify-center w-10 h-10 mx-auto mb-0.5 rounded-xl transition-all duration-150
                ${activo
                  ? "bg-gradient-to-br from-[#2f8ee9] to-[#1262bd] shadow-md shadow-blue-900/40"
                  : "hover:bg-white/10"
                }
              `}
            >
              <Icon
                size={17}
                strokeWidth={activo ? 2.5 : 1.8}
                className={activo ? "text-white" : "text-white/50 group-hover:text-white transition-colors"}
              />
              <span className="
                pointer-events-none absolute left-full ml-3 z-50
                px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white whitespace-nowrap
                bg-[#0b2545] border border-white/10 shadow-xl
                opacity-0 group-hover:opacity-100
                translate-x-1 group-hover:translate-x-0
                transition-all duration-150
              ">
                {item.label}
                <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-[#0b2545]" />
              </span>
            </Link>
          );
        })}
        {grupo !== "Principal" && (
          <div className="my-1.5 mx-3 border-t border-white/5" />
        )}
      </div>
    );
  }

  // ── Modo expandido ───────────────────────────────────────────────────────
  return (
    <div className="mb-1">
      {grupo !== "Principal" && (
        <button
          onClick={() => setAbierto((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-1.5 text-left group"
        >
          <span className="text-[9px] font-black uppercase tracking-[0.15em] text-white/30 group-hover:text-white/50 transition-colors">
            {grupo}
          </span>
          <Ic.ChevronRight
            size={10}
            strokeWidth={2.5}
            className={`text-white/25 transition-transform duration-200 ${abierto ? "rotate-90" : ""}`}
          />
        </button>
      )}

      {abierto && (
        <div className="space-y-0.5">
          {itemsVisibles.map((item) => {
            const activo = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`
                  group flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-all duration-150
                  ${activo
                    ? "bg-gradient-to-r from-[#2f8ee9] to-[#1262bd] shadow-md shadow-blue-900/30"
                    : "hover:bg-white/8"
                  }
                `}
              >
                <div className={`
                  w-7 h-7 flex items-center justify-center rounded-lg flex-shrink-0 transition-all
                  ${activo ? "bg-white/15" : "bg-white/5 group-hover:bg-white/10"}
                `}>
                  <Icon
                    size={14}
                    strokeWidth={activo ? 2.5 : 1.8}
                    className={activo ? "text-white" : "text-white/50 group-hover:text-white/90"}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-[12px] font-semibold leading-tight truncate transition-colors
                    ${activo ? "text-white" : "text-white/70 group-hover:text-white"}`}>
                    {item.label}
                  </p>
                  <p className={`text-[10px] truncate transition-colors
                    ${activo ? "text-blue-100/60" : "text-white/25"}`}>
                    {item.sub}
                  </p>
                </div>
                {activo && (
                  <div className="w-1 h-1 rounded-full bg-white/80 flex-shrink-0" />
                )}
              </Link>
            );
          })}
        </div>
      )}

      {grupo !== "Principal" && (
        <div className="mt-1.5 border-t border-white/5" />
      )}
    </div>
  );
}

// ─── Layout principal ───────────────────────────────────────────────────────
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const esLogin = pathname === "/login";
  const esPublica = ["/conductor"].some(
    (r) => pathname === r || pathname.startsWith(r + "/")
  );

  const [emailUsuario, setEmailUsuario]   = useState("");
  const [nombreUsuario, setNombreUsuario] = useState("Usuario");
  const [rolUsuario, setRolUsuario]       = useState("operador");
  const [permisos, setPermisos]           = useState<string[]>([]);
  const [cargando, setCargando]           = useState(true);
  const [collapsed, setCollapsed]         = useState(false);

  useEffect(() => {
    async function cargarSesionPermisos() {
      if (esLogin || esPublica) { setCargando(false); return; }
      setCargando(true);

      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) { router.replace("/login"); return; }

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
    try { await supabase.auth.signOut(); }
    catch (error) { console.error("Error al cerrar sesión:", error); }
    finally { window.location.href = "/login"; }
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
          <div style={{ margin: 0, padding: 0, height: "100vh" }}>{children}</div>

        ) : cargando ? (
          <div className="min-h-screen flex items-center justify-center bg-[#eef3f8]">
            <div className="text-center">
              <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-gray-300 border-t-[#0b315f]" />
              <p className="font-bold text-[#0b315f]">Validando permisos...</p>
            </div>
          </div>

        ) : (
          <div className="min-h-screen flex bg-[#eef3f8]">

            <aside
              className={`
                relative flex flex-col flex-shrink-0
                bg-gradient-to-b from-[#0c2d52] via-[#091f3a] to-[#040f1e]
                text-white shadow-2xl
                transition-all duration-300 ease-in-out
                ${collapsed ? "w-[64px]" : "w-[210px]"}
              `}
            >
              <button
                onClick={() => setCollapsed((v) => !v)}
                className="
                  absolute -right-3 top-[68px] z-20
                  w-6 h-6 rounded-full bg-[#2f8ee9] shadow-lg
                  flex items-center justify-center
                  hover:bg-[#1262bd] transition-colors
                "
                title={collapsed ? "Expandir menú" : "Colapsar menú"}
              >
                {collapsed
                  ? <Ic.PanelOpen  size={11} strokeWidth={2} className="text-white" />
                  : <Ic.PanelClose size={11} strokeWidth={2} className="text-white" />
                }
              </button>

              <div className={`
                flex items-center border-b border-white/8
                transition-all duration-300
                ${collapsed ? "p-2.5 justify-center" : "p-3"}
              `}>
                <LogoAFA collapsed={collapsed} />
              </div>

              {!collapsed && (
                <div className="px-3 py-2 border-b border-white/5">
                  <div className="flex items-center gap-2 bg-white/5 rounded-lg px-2.5 py-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                    <div>
                      <p className="text-white/75 text-[11px] font-semibold leading-none">Sistema de Gestión</p>
                      <p className="text-white/30 text-[9px] uppercase tracking-widest mt-0.5">ERP Transporte</p>
                    </div>
                  </div>
                </div>
              )}

              <nav
                className={`flex-1 overflow-y-auto overflow-x-hidden py-2 ${collapsed ? "px-1.5" : "px-2"}`}
                style={{ scrollbarWidth: "none" }}
              >
                {menuGrupos.map((g) => (
                  <GrupoMenu
                    key={g.grupo}
                    grupo={g.grupo}
                    items={g.items}
                    pathname={pathname}
                    permisos={permisos}
                    collapsed={collapsed}
                  />
                ))}
              </nav>

              <div className={`
                border-t border-white/8 bg-black/15 transition-all duration-300
                ${collapsed ? "p-2" : "p-3"}
              `}>
                {collapsed ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#2f8ee9] to-[#0b315f] text-white flex items-center justify-center font-black text-sm shadow">
                      {nombreUsuario.charAt(0).toUpperCase()}
                    </div>
                    <button
                      onClick={cerrarSesion}
                      title="Cerrar sesión"
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-red-600/15 hover:bg-red-600/35 transition-colors"
                    >
                      <Ic.LogOut size={13} strokeWidth={2} className="text-red-400" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2.5 mb-2.5">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#2f8ee9] to-[#0b315f] text-white flex items-center justify-center font-black text-sm shadow flex-shrink-0">
                        {nombreUsuario.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-[12px] text-white/90 leading-tight truncate">{nombreUsuario}</p>
                        <p className="text-[9px] text-white/30 truncate">{emailUsuario}</p>
                        <span className="inline-block text-[9px] font-black text-amber-400/90 uppercase tracking-wider bg-amber-400/10 px-1.5 py-0.5 rounded mt-0.5">
                          {rolUsuario === "admin" ? "Admin" : "Operador"}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={cerrarSesion}
                      className="w-full flex items-center justify-center gap-1.5 bg-red-600/12 hover:bg-red-600/28 border border-red-500/15 text-red-400 hover:text-red-300 text-[11px] font-bold py-1.5 rounded-lg transition-all"
                    >
                      <Ic.LogOut size={12} strokeWidth={2} />
                      Cerrar sesión
                    </button>
                  </>
                )}
              </div>
            </aside>

            <main className="flex-1 overflow-y-auto p-6">{children}</main>
          </div>
        )}
      </body>
    </html>
  );
}