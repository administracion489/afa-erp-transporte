"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { Manrope, JetBrains_Mono } from "next/font/google";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { EVENTO_ENTRADA_MARCADA } from "@/lib/rrhh/fichador";
import { ImgPrivada } from "@/components/ArchivoPrivado";
import EliaPanel from "./_components/elia";
import AyudaModulo from "./_components/AyudaModulo";
import NotificadorMensajesPasajeros from "@/components/NotificadorMensajesPasajeros";
import { useMensajesNoLeidosPasajero } from "@/lib/useMensajesNoLeidos";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

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
  Zap: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
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
  // ── Nuevos para el dashboard redesign ────────────────────────────────
  TrendingUp: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
    </svg>
  ),
  Download: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  ),
  Bell: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2v1h16v-1l-2-2z"/><path d="M10 20a2 2 0 0 0 4 0"/>
    </svg>
  ),
  MoreH: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>
    </svg>
  ),
  ArrowRight: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  ),
  Plus: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  Filter: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
    </svg>
  ),
  MessageSquare: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  Bot: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/>
    </svg>
  ),
  // ── Liquidaciones (balanza) y Contabilidad (libro) ──────────────────────
  Scale: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 6a3 3 0 0 0 6 0z"/><path d="m19 7-3 6a3 3 0 0 0 6 0z"/><path d="M7 21h10"/>
    </svg>
  ),
  BookOpen: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    </svg>
  ),
  Wallet: ({ size = 16, strokeWidth = 2, className = "" }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5"/><path d="M18 12a1 1 0 0 0 0 2h2v-2z"/>
    </svg>
  ),
};

// ─── Tipos ─────────────────────────────────────────────────────────────────
type IconComponent = (props: IconProps) => ReactElement;
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
      // "Mi Perfil" (/mi-perfil) YA NO vive aquí: se abre desde el bloque de usuario del pie del
      // menú (ver MenuUsuario). Al salir de `menuGrupos` deja de estar en `menu`, así que el gate
      // del RootLayout lo trata aparte (ver la rama `pathname === "/mi-perfil"`), igual que
      // /seguimiento/gps/. La guarda fina de la pantalla la hace usePermiso("mi-perfil").
    ],
  },
  {
    grupo: "Comercial",
    items: [
      { href: "/cotizaciones",           label: "Cotizaciones",  sub: "Precios y rutas",        icon: Ic.FileText,   modulo: "cotizaciones" },
      { href: "/cotizador",              label: "Cotizador",     sub: "Estructura de costos",   icon: Ic.Calculator, modulo: "cotizaciones" },
      { href: "/cotizaciones/plantillas",label: "Plantillas PDF",sub: "Diseño de cotizaciones", icon: Ic.FileText,   modulo: "cotizaciones" },
      { href: "/tarifario",    label: "Tarifas",      sub: "Tarifarios",           icon: Ic.DollarSign, modulo: "tarifas"      },
      { href: "/clientes",     label: "Clientes",     sub: "Base comercial",       icon: Ic.Users,      modulo: "clientes"     },
    ],
  },
  {
    grupo: "CRM",
    items: [
      { href: "/crm",          label: "Inbox CRM",  sub: "Conversaciones",      icon: Ic.MessageSquare, modulo: "crm" },
      { href: "/crm/notificaciones", label: "Inbox Notificaciones", sub: "Respuestas a avisos automáticos", icon: Ic.Bell, modulo: "crm" },
      { href: "/crm/pipeline", label: "Pipeline",   sub: "Embudo de ventas",    icon: Ic.TrendingUp,    modulo: "crm" },
      { href: "/crm/agente",   label: "Agente IA",  sub: "Asistente con Claude", icon: Ic.Bot,          modulo: "crm" },
      { href: "/crm/campanas", label: "Campañas",   sub: "Envíos masivos WhatsApp/Email", icon: Ic.Bell, modulo: "crm" },
      { href: "/radar-ia",     label: "Radar IA",   sub: "Grupos WhatsApp → ERP", icon: Ic.Radio,       modulo: "radar-ia" },
      { href: "/redes",        label: "Redes sociales", sub: "Publicación diaria", icon: Ic.Bell,       modulo: "redes" },
    ],
  },
  {
    grupo: "Operaciones",
    items: [
      { href: "/despachador",  label: "Despachador",  sub: "Servicios urgentes",    icon: Ic.Zap,           modulo: "despachador"  },
      { href: "/calendario",   label: "Calendario",   sub: "Servicios del día",     icon: Ic.Calendar,      modulo: "dashboard"    },
      { href: "/programacion", label: "Programación", sub: "Core del sistema",      icon: Ic.CalendarRange, modulo: "programacion" },
      { href: "/seguimiento",  label: "Seguimiento",  sub: "Estado en tiempo real", icon: Ic.Search,        modulo: "seguimiento"  },
      { href: "/monitoreo",    label: "Monitoreo",    sub: "Mapa y unidades",       icon: Ic.Radio,         modulo: "monitoreo"    },
      // Reusa el módulo "monitoreo" a propósito: quien vigila la flota es quien debe ver si a
      // un conductor se le corta el rastreo. Así no hay que dar un permiso nuevo a nadie.
      { href: "/gps-salud",    label: "Salud del GPS", sub: "Rastreo por conductor", icon: Ic.Radio,        modulo: "monitoreo"    },
      // También "monitoreo": los excesos se juzgan con el mismo GPS en vivo que vigila /gps-salud
      // (su API, /api/flota/excesos, exige este módulo). No hay permiso nuevo que repartir.
      { href: "/seguridad-vial", label: "Seguridad vial", sub: "Excesos de velocidad", icon: Ic.AlertTriangle, modulo: "monitoreo" },
      { href: "/pasajeros",    label: "Pasajeros",    sub: "Base de pasajeros",     icon: Ic.Users,         modulo: "pasajeros"    },
      { href: "/comunicados",  label: "Comunicados",  sub: "Envíos masivos WhatsApp/Correo", icon: Ic.MessageSquare, modulo: "comunicados" },
      { href: "/multas",       label: "Multas",       sub: "Infracciones",          icon: Ic.Fine,          modulo: "multas"       },
      { href: "/incidencias",  label: "Incidencias",  sub: "Eventos y alertas",     icon: Ic.AlertTriangle, modulo: "incidencias"  },
    ],
  },
  {
    grupo: "Flota",
    items: [
      { href: "/vehiculos",              label: "Vehículos",          sub: "Flota",              icon: Ic.Bus,       modulo: "vehiculos"    },
      { href: "/documentos-vehiculares", label: "Docs. Vehiculares",  sub: "SOAT · CITV · MTC",  icon: Ic.FileCheck, modulo: "vehiculos"    },
      { href: "/mantenimiento",          label: "Mantenimiento",      sub: "Próximos · OT · planes · odómetro", icon: Ic.Wrench,    modulo: "mantenimiento"},
      { href: "/neumaticos",             label: "Neumáticos",         sub: "Vida útil",           icon: Ic.Circle,    modulo: "neumaticos"   },
      { href: "/combustible",            label: "Combustible",        sub: "Consumo",             icon: Ic.Fuel,      modulo: "combustible"  },
      { href: "/auditoria-jornada",      label: "Auditoría km",       sub: "Jornada vs servicio", icon: Ic.Scale,     modulo: "combustible"  },
      // "vehiculos" y no un módulo nuevo: son métricas de la flota, y un módulo propio obligaría a
      // tocar las tres listas de módulos (layout, crear-usuario y /usuarios) sin que nadie lo pida.
      { href: "/uso-flota",              label: "Uso de flota",       sub: "Km · servicios · CO₂", icon: Ic.BarChart, modulo: "vehiculos"   },
      { href: "/seguros",                label: "Seguros",            sub: "Pólizas",             icon: Ic.Shield,    modulo: "seguros"      },
    ],
  },
  {
    grupo: "RRHH",
    items: [
      { href: "/rrhh",                    label: "Control de Personal", sub: "Asistencia · ausencias", icon: Ic.Users,    modulo: "rrhh" },
      { href: "/conductores",             label: "Conductores",    sub: "Choferes",        icon: Ic.UserCheck, modulo: "conductores"            },
      { href: "/personal-administrativo", label: "Personal Adm.", sub: "Equipo interno",  icon: Ic.Briefcase, modulo: "personal-administrativo" },
    ],
  },
  {
    grupo: "Proveedores",
    items: [
      { href: "/proveedores",     label: "Proveedores",      sub: "Talleres · grifos",     icon: Ic.Building,  modulo: "proveedores" },
      { href: "/tercerizadas",    label: "Tercerizadas",     sub: "Flota externa",         icon: Ic.Handshake, modulo: "proveedores" },
      { href: "/ordenes-compra", label: "Órdenes de Compra", sub: "Compras a proveedores", icon: Ic.Clipboard, modulo: "ordenes-compra" },
    ],
  },
  {
    grupo: "Finanzas",
    items: [
      { href: "/pactos",        label: "Pactos",        sub: "Costos sin pactar · Por visar", icon: Ic.Handshake, modulo: "pactos" },
      { href: "/liquidaciones", label: "Liquidaciones", sub: "Cierre cliente / proveedor", icon: Ic.Scale,        modulo: "liquidaciones" },
      { href: "/finanzas",      label: "Finanzas",      sub: "Ingresos · Egresos · Tesorería", icon: Ic.Wallet,   modulo: "finanzas"      },
      { href: "/tesoreria",     label: "Cuentas por Pagar", sub: "CxP · Planilla · Detracciones · Banco", icon: Ic.Clipboard, modulo: "tesoreria" },
      { href: "/caja-chica",    label: "Caja Chica",    sub: "Entregas y rendiciones", icon: Ic.DollarSign,  modulo: "caja-chica"  },
      { href: "/facturacion",   label: "Facturación",   sub: "SUNAT / comprobantes",  icon: Ic.Receipt,      modulo: "facturacion" },
      { href: "/gastos",        label: "Gastos",        sub: "Egresos",               icon: Ic.TrendingDown, modulo: "gastos"      },
      { href: "/comisiones",    label: "Comisiones",    sub: "Ejecutivo de ventas",   icon: Ic.DollarSign,   modulo: "comisiones"  },
    ],
  },
  {
    grupo: "Contabilidad",
    items: [
      { href: "/contabilidad", label: "Contabilidad", sub: "Compras · IGV · Asientos", icon: Ic.BookOpen, modulo: "contabilidad" },
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
    grupo: "Configuración",
    items: [
      { href: "/configuracion/perfil",   label: "Perfil Empresa", sub: "Datos · Logo",        icon: Ic.Building, modulo: "configuracion" },
      { href: "/configuracion/costos",   label: "Costos",         sub: "Flota y combustible",  icon: Ic.Settings, modulo: "ajustes"       },
      { href: "/configuracion/usuarios", label: "Usuarios",       sub: "Permisos de acceso",   icon: Ic.Lock,     modulo: "usuarios"      },
      { href: "/configuracion/elia",     label: "ELIA",           sub: "Asistente IA · gasto", icon: Ic.Bot,      modulo: "configuracion" },
      { href: "/configuracion/operaciones", label: "Alertas y Mensajes", sub: "Avisos WhatsApp · contactos", icon: Ic.Bell, modulo: "configuracion" },
      { href: "/configuracion/sistema",  label: "Sistema",        sub: "Parámetros generales", icon: Ic.Wrench,    modulo: "configuracion" },
      { href: "/configuracion/legal",   label: "Páginas Legales",sub: "Privacidad · Términos",icon: Ic.FileText, modulo: "configuracion" },
    ],
  },
];

const menu = menuGrupos.flatMap((g) => g.items);

// Grupos que arrancan abiertos por defecto
const GRUPOS_ABIERTOS_DEFAULT = ["Principal", "Comercial", "CRM", "Operaciones", "Flota"];

// Pantallas que dibujan un mapa a ALTO COMPLETO: su <main> mide exactamente el alto
// visible y no lleva padding, así el mapa llena la pantalla y el documento no scrollea.
// La página tiene que usar `h-full` (no `h-screen`): con h-screen dentro de un main con
// padding sobraba alto y, al desplazar, aparecía el hueco en blanco debajo del mapa.
// Coincide la ruta exacta o cualquier sub-ruta (`ruta + "/"`).
const RUTAS_PANTALLA_COMPLETA = ["/monitoreo"];

// Celular: el menú arranca colapsado y se vuelve a colapsar al navegar. Se lee con
// useSyncExternalStore y no en el render: en el servidor no hay `window`, y el snapshot
// del servidor (false) es el que React usa al hidratar, así que no hay desajuste.
const CONSULTA_PANTALLA_CHICA = "(max-width: 767px)";
function suscribirPantallaChica(aviso: () => void) {
  const mq = window.matchMedia(CONSULTA_PANTALLA_CHICA);
  mq.addEventListener("change", aviso);
  return () => mq.removeEventListener("change", aviso);
}
const esPantallaChicaAhora = () => window.matchMedia(CONSULTA_PANTALLA_CHICA).matches;
const esPantallaChicaEnServidor = () => false;

// Cuánto contenido del menú tiene que quedar por debajo para pintar la pista inferior.
// Unos pocos px de redondeo de subpíxel no son "más ítems".
const MENU_RESTO_MIN_PX = 4;

// ─── Logo ───────────────────────────────────────────────────────────────────
function LogoAFA({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <div className="w-10 h-10 mx-auto flex items-center justify-center">
        <img src="/logoafa-blanco-icono.png" alt="AFA" className="w-10 object-contain drop-shadow-[0_2px_6px_rgba(47,142,233,0.45)]" />
      </div>
    );
  }
  return (
    <div className="w-full px-2 py-1 flex items-center justify-center">
      <img src="/logoafa-blanco.png" alt="AFA Transportes" className="w-full max-h-16 object-contain drop-shadow-[0_2px_8px_rgba(47,142,233,0.45)]" />
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
  badges,
}: {
  grupo: string;
  items: MenuItem[];
  pathname: string;
  permisos: string[];
  collapsed: boolean;
  badges?: Record<string, number>;
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
          const badge = badges?.[item.href] || 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`
                group relative flex items-center justify-center w-10 h-10 mx-auto mb-0.5 rounded-xl transition-all duration-150
                ${activo
                  ? "bg-gradient-to-br from-[#2f8ee9] to-[#1262bd] shadow-md shadow-blue-900/40"
                  : "hover:bg-white/12"
                }
              `}
            >
              <Icon
                size={17}
                strokeWidth={activo ? 2.5 : 1.8}
                className={activo ? "text-white" : "text-white/85 group-hover:text-white transition-colors"}
              />
              {badge > 0 && (
                <span
                  className="absolute -top-1 -right-1 flex items-center justify-center rounded-full bg-red-500 text-white font-black"
                  style={{ minWidth: 16, height: 16, padding: "0 3px", fontSize: 9 }}
                >
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
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
          <span className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-sky-300/80 group-hover:text-sky-200 transition-colors">
            {grupo}
          </span>
          <Ic.ChevronRight
            size={10}
            strokeWidth={2.5}
            className={`text-sky-300/70 transition-transform duration-200 ${abierto ? "rotate-90" : ""}`}
          />
        </button>
      )}

      {abierto && (
        <div className="space-y-0.5">
          {itemsVisibles.map((item) => {
            const activo = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            const badge = badges?.[item.href] || 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`
                  group flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-all duration-150
                  ${activo
                    ? "bg-gradient-to-r from-[#2f8ee9] to-[#1262bd] shadow-md shadow-blue-900/30"
                    : "hover:bg-white/10 hover:translate-x-0.5"
                  }
                `}
              >
                <div className={`
                  relative w-7 h-7 flex items-center justify-center rounded-lg flex-shrink-0 transition-all
                  ${activo ? "bg-white/20" : "bg-white/10 ring-1 ring-white/10 group-hover:bg-[#2f8ee9]/30 group-hover:ring-[#2f8ee9]/40"}
                `}>
                  <Icon
                    size={15}
                    strokeWidth={activo ? 2.5 : 2}
                    className={activo ? "text-white" : "text-white/90 group-hover:text-white"}
                  />
                  {badge > 0 && (
                    <span
                      className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full bg-red-500 text-white font-black"
                      style={{ minWidth: 16, height: 16, padding: "0 3px", fontSize: 9 }}
                    >
                      {badge > 9 ? "9+" : badge}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-[12px] font-semibold leading-tight truncate transition-colors
                    ${activo ? "text-white" : "text-white/95 group-hover:text-white"}`}>
                    {item.label}
                  </p>
                  <p className={`text-[10px] truncate transition-colors
                    ${activo ? "text-blue-50/85" : "text-slate-300/70 group-hover:text-slate-200"}`}>
                    {item.sub}
                  </p>
                </div>
                {badge > 0 ? (
                  <span className="flex-shrink-0 rounded-full bg-red-500 text-white font-black flex items-center justify-center"
                    style={{ minWidth: 18, height: 18, padding: "0 5px", fontSize: 10 }}>
                    {badge > 9 ? "9+" : badge}
                  </span>
                ) : activo && (
                  <div className="w-1 h-1 rounded-full bg-white/80 flex-shrink-0" />
                )}
              </Link>
            );
          })}
        </div>
      )}

      {grupo !== "Principal" && (
        <div className="mt-1.5 border-t border-white/10" />
      )}
    </div>
  );
}

// ─── Bloque de usuario (pie del menú) = acceso a Mi Perfil ───────────────────
// Es un BOTÓN (no un div) que abre un popover con "Mi Perfil" y "Cerrar sesión".
// Funciona colapsado (solo el avatar) y expandido (avatar + nombre + correo + rol),
// y en celular (el aside completo se despliega y este bloque queda abajo). El popover
// se cierra al navegar, al hacer clic fuera o con Escape; accesible por teclado.
function MenuUsuario({
  nombre,
  email,
  rol,
  foto,
  collapsed,
  onCerrarSesion,
}: {
  nombre: string;
  email: string;
  rol: string;
  foto: string | null;
  collapsed: boolean;
  onCerrarSesion: () => void;
}) {
  const pathname = usePathname();
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const enPerfil = pathname === "/mi-perfil";

  // Se cierra al cambiar de ruta. Se hace comparando en el render (no en un efecto, que
  // dispararía set-state-in-effect), igual que el reinicio del menú móvil del RootLayout.
  const [rutaVista, setRutaVista] = useState(pathname);
  if (rutaVista !== pathname) {
    setRutaVista(pathname);
    if (abierto) setAbierto(false);
  }

  // Se cierra al hacer clic fuera o con Escape.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAbierto(false); };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", esc);
    };
  }, [abierto]);

  const inicial = (nombre || "U").charAt(0).toUpperCase();
  const rolLabel = rol === "admin" ? "Admin" : "Operador";

  const avatar = (clase: string) => (
    <div className={`
      ${clase} rounded-full overflow-hidden flex-shrink-0 shadow
      bg-gradient-to-br from-[#2f8ee9] to-[#0b315f]
      text-white flex items-center justify-center font-black
    `}>
      {foto
        ? <ImgPrivada src={foto} alt="" className="w-full h-full object-cover" />
        : inicial}
    </div>
  );

  const popover = (
    <div
      role="menu"
      aria-label="Menú de usuario"
      className={`
        absolute bottom-full mb-2 z-50 p-1
        ${collapsed ? "left-0 w-52" : "left-0 right-0"}
        rounded-xl border border-white/10 bg-[#0b2545] shadow-2xl shadow-black/50
      `}
    >
      {/* En colapsado el trigger no dice quién es; el popover sí. */}
      {collapsed && (
        <div className="px-2.5 py-2 mb-1 border-b border-white/5">
          <p className="text-[12px] font-bold text-white/90 truncate">{nombre}</p>
          <p className="text-[10px] text-slate-300/75 truncate">{email}</p>
          <span className="inline-block mt-1 text-[8px] font-black uppercase tracking-wider text-amber-400/90 bg-amber-400/10 px-1.5 py-0.5 rounded">
            {rolLabel}
          </span>
        </div>
      )}
      <Link
        href="/mi-perfil"
        role="menuitem"
        onClick={() => setAbierto(false)}
        className={`
          flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12px] font-semibold transition-colors
          outline-none focus-visible:bg-white/10
          ${enPerfil ? "bg-white/10 text-white" : "text-white/75 hover:bg-white/10 hover:text-white"}
        `}
      >
        <Ic.UserCheck size={14} strokeWidth={2} />
        Mi Perfil
      </Link>
      <button
        type="button"
        role="menuitem"
        onClick={() => { setAbierto(false); onCerrarSesion(); }}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12px] font-semibold text-red-300 hover:bg-red-600/25 hover:text-red-200 transition-colors outline-none focus-visible:bg-red-600/25"
      >
        <Ic.LogOut size={14} strokeWidth={2} />
        Cerrar sesión
      </button>
    </div>
  );

  // ── Colapsado: solo el avatar ──
  if (collapsed) {
    return (
      <div ref={ref} className="relative flex justify-center">
        {abierto && popover}
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={abierto}
          title={`${nombre} · ${rolLabel}`}
          className={`
            w-9 h-9 rounded-full transition-all
            outline-none focus-visible:ring-2 focus-visible:ring-[#2f8ee9]
            ${abierto ? "ring-2 ring-[#2f8ee9]" : "hover:brightness-110"}
          `}
        >
          {avatar("w-9 h-9 text-sm")}
        </button>
      </div>
    );
  }

  // ── Expandido: avatar + nombre + correo + rol + chevron ──
  return (
    <div ref={ref} className="relative">
      {abierto && popover}
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        className={`
          w-full flex items-center gap-2.5 p-1.5 rounded-xl text-left transition-colors
          outline-none focus-visible:ring-2 focus-visible:ring-[#2f8ee9]
          ${abierto ? "bg-white/10" : "hover:bg-white/8"}
        `}
      >
        {avatar("w-9 h-9 text-sm")}
        <div className="min-w-0 flex-1">
          <p className="font-bold text-[12px] text-white leading-tight truncate">{nombre}</p>
          <p className="text-[10px] text-slate-300/75 truncate">{email}</p>
        </div>
        <span className="flex items-center gap-1 flex-shrink-0">
          <span className="text-[8px] font-black uppercase tracking-wider text-amber-400/90 bg-amber-400/10 px-1.5 py-0.5 rounded">
            {rolLabel}
          </span>
          <Ic.ChevronRight
            size={13}
            strokeWidth={2.5}
            className={`text-white/60 transition-transform duration-200 ${abierto ? "rotate-90" : "-rotate-90"}`}
          />
        </span>
      </button>
    </div>
  );
}

// ─── Layout principal ───────────────────────────────────────────────────────
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const esLogin = pathname === "/login";
  const esPublica =
    // Rutas públicas estándar (raíz + sub-rutas)
    // /conformidad/[token] es público: el cliente aprueba su liquidación sin cuenta.
    // /conformidad-cambio/[token] es su equivalente para UN cambio de servicio (el
    // cliente pidió una unidad mayor): su firma es lo que hace cobrable el diferencial.
    // Va ANTES que "/conformidad" en la lista por claridad; el `some` no depende del
    // orden, pero sí de que sea su propia entrada — "/conformidad" no lo cubre, porque
    // el prefijo se compara con "/" al final y "conformidad-cambio" no calza.
    ["/conductor", "/lector", "/pasajero", "/registro", "/privacidad", "/cliente", "/conductor-tercero", "/manuales", "/conformidad-cambio", "/conformidad", "/proveedor"].some(
      (r) => pathname === r || pathname.startsWith(r + "/")
    ) ||
    // /seguimiento/[token] es público — pero /seguimiento (módulo ERP) NO, y tampoco
    // /seguimiento/gps/[id]: es una vista INTERNA (lee reservas, conductores y vehículos con
    // la sesión del ERP) que se colaba como pública solo por compartir el prefijo.
    (pathname.startsWith("/seguimiento/") && !pathname.startsWith("/seguimiento/gps/")) ||
    // Bancos de pruebas visuales (/dev/*) — solo existen en desarrollo
    (process.env.NODE_ENV !== "production" && pathname.startsWith("/dev/"));

  const [emailUsuario, setEmailUsuario]   = useState("");
  const [nombreUsuario, setNombreUsuario] = useState("Usuario");
  const [rolUsuario, setRolUsuario]       = useState("operador");
  const [permisos, setPermisos]           = useState<string[]>([]);
  const [cargando, setCargando]           = useState(true);
  const [collapsed, setCollapsed]         = useState(false);
  const [fotoPerfil, setFotoPerfil]       = useState<string | null>(null);
  const fotoPedidaRef                     = useRef(false);

  // Fichaje: un usuario que DEBE marcar asistencia y aún no marcó su ENTRADA de hoy aterriza
  // directo en la pantalla de marcar. Se resuelve UNA sola vez por montaje del layout
  // (`fichajeResueltoRef`, mismo patrón que `fotoPedidaRef`), NUNCA en cada navegación: un
  // re-redirect por navegación sería un lock duro del ERP entero y encerraría a un fichador cuya
  // cámara/consentimiento/rostro fallara. FAIL-OPEN: ante cualquier fallo, NO pendiente, NO bloquea.
  const [fichajePendiente, setFichajePendiente] = useState(false);
  const fichajeResueltoRef                      = useRef(false);

  // En celular el menú no usa `collapsed` (que es el de escritorio, y ahí todo sigue
  // igual): va colapsado salvo que la persona lo abra a mano, y CADA navegación lo vuelve
  // a colapsar (también volver a una ruta donde ya se había abierto). El reinicio se hace
  // durante el render al ver otro pathname, no en un efecto: así no hay un cuadro con el
  // menú abierto tapando la pantalla nueva.
  const pantallaChica = useSyncExternalStore(suscribirPantallaChica, esPantallaChicaAhora, esPantallaChicaEnServidor);
  const [menuAbiertoEnCelular, setMenuAbiertoEnCelular] = useState(false);
  const [rutaDelMenu, setRutaDelMenu] = useState(pathname);
  if (rutaDelMenu !== pathname) {
    setRutaDelMenu(pathname);
    setMenuAbiertoEnCelular(false);
  }
  const menuColapsado = pantallaChica ? !menuAbiertoEnCelular : collapsed;
  const alternarMenu = () => {
    if (pantallaChica) setMenuAbiertoEnCelular((v) => !v);
    else setCollapsed((v) => !v);
  };

  const esPantallaCompleta = RUTAS_PANTALLA_COMPLETA.some(
    (r) => pathname === r || pathname.startsWith(r + "/")
  );

  // Pista de "hay más menú abajo": la barra de scroll del <nav> está oculta, así que sin
  // el degradado no se nota que hay ítems por debajo del borde. Se mide al desplazar y
  // cuando cambia el alto del nav o de su contenido (abrir un grupo, colapsar el menú).
  const navMenuRef = useRef<HTMLElement | null>(null);
  const [menuSigueAbajo, setMenuSigueAbajo] = useState(false);
  const medirMenu = useCallback(() => {
    const nav = navMenuRef.current;
    if (!nav) return;
    setMenuSigueAbajo(nav.scrollHeight - nav.scrollTop - nav.clientHeight > MENU_RESTO_MIN_PX);
  }, []);
  const montarNavMenu = useCallback((nav: HTMLElement | null) => {
    navMenuRef.current = nav;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(medirMenu);
    ro.observe(nav);
    if (nav.firstElementChild) ro.observe(nav.firstElementChild);
    return () => {
      ro.disconnect();
      navMenuRef.current = null;
    };
  }, [medirMenu]);

  // Mensajes de pasajeros sin atender — global, para el badge del menú y el
  // notificador (toast/sonido/aviso), sin importar en qué módulo esté el operador.
  const { noLeidos: mensajesNoLeidos, ultimo: ultimoMensaje } =
    useMensajesNoLeidosPasajero(!esLogin && !esPublica && !cargando && permisos.includes("seguimiento"));
  const badgesMenu = { "/seguimiento": mensajesNoLeidos };

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

      const esAdmin = perfil.rol === "admin";
      let listaPermisos = permisosData?.map((p: any) => p.modulo) || [];
      if (esAdmin) {
        listaPermisos = [...new Set(menu.map((item) => item.modulo))];
      }
      setPermisos(listaPermisos);

      // «Ver recorrido» (/seguimiento/gps/[id]) lo abren tres pantallas: Seguimiento, Seguridad vial
      // (monitoreo) y Uso de flota (vehiculos). Su API (/api/seguimiento/recorrido) acepta cualquiera
      // de los tres, y la pantalla tiene que aceptar los mismos: si no, quien llega desde Seguridad vial
      // sin el módulo Seguimiento termina en el dashboard.
      const MODULOS_RECORRIDO = ["seguimiento", "monitoreo", "vehiculos"];
      const rutaActual = menu.find(
        (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
      );
      // /mi-perfil salió de `menuGrupos`, así que `rutaActual` no lo encuentra. Se gobierna
      // explícitamente con el mismo permiso que usePermiso("mi-perfil") exige en la pantalla:
      // admin pasa siempre, y el resto solo con el módulo "mi-perfil" (que todo usuario tiene
      // sembrado). Sin esta rama caería en `!rutaActual` → pasaría sin mirar el permiso.
      const permitida = pathname.startsWith("/seguimiento/gps/")
        ? MODULOS_RECORRIDO.some((m) => listaPermisos.includes(m))
        : pathname === "/mi-perfil"
        ? esAdmin || listaPermisos.includes("mi-perfil")
        : !rutaActual || listaPermisos.includes(rutaActual.modulo);
      if (!permitida) {
        router.replace("/dashboard");
        return;
      }

      // ── Fichaje: ¿este usuario debe marcar y aún no marcó su ENTRADA de hoy? ───────────────
      // REDIRECT DE PRIMERA CARGA, no un lock: se resuelve UNA sola vez por montaje
      // (`fichajeResueltoRef`), así que la navegación posterior NO vuelve a redirigir. Si la
      // persona navega a otro lado sin marcar, se lo permitimos (fail-open: el gate del ERP no
      // puede atrapar a nadie). `GET /api/rrhh/estado-fichaje` ya es fail-open; aquí reforzamos:
      // todo en try/catch, y solo es "pendiente" cuando `es_fichador === true` Y
      // `marco_entrada_hoy === false`. Cualquier otra cosa (error, red caída, campos que no sean
      // exactamente esos) → NO pendiente, y el ERP se usa con normalidad. Un fallo de este
      // endpoint JAMÁS debe impedir trabajar. Para quien no ficha (es_fichador:false) nada cambia.
      if (!fichajeResueltoRef.current) {
        fichajeResueltoRef.current = true;
        // Timeout de cliente: el fichaje NUNCA puede retener el primer render del ERP. Un endpoint
        // LENTO (no caído) es tan dañino como uno caído en este camino crítico, así que a los 4 s se
        // aborta y se trata como fail-open (no pendiente). Así el login no espera a RRHH jamás.
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 4000);
        try {
          const res = await fetch("/api/rrhh/estado-fichaje", { headers: await cabecerasErp(), signal: ac.signal });
          const d = await res.json().catch(() => null);
          const pend = d?.es_fichador === true && d?.marco_entrada_hoy === false;
          setFichajePendiente(pend);
          if (pend && pathname !== "/mi-perfil") {
            // Aterriza en marcar. La navegación re-ejecuta el efecto, pero `fichajeResueltoRef`
            // ya está en true: no vuelve a redirigir, y el `setCargando(false)` corre ahí.
            router.replace("/mi-perfil?tab=marcar");
            return;
          }
        } catch {
          /* FAIL-OPEN: un fallo, un timeout (abort 4 s) o red caída no vuelve "pendiente" a nadie ni bloquea el ERP */
        } finally {
          clearTimeout(t);
        }
      }

      setCargando(false);
    }
    cargarSesionPermisos();
  }, [pathname, esLogin, esPublica, router]);

  // Foto del perfil para el avatar del bloque de usuario (si existe). Se pide UNA vez por
  // montaje del layout, no en cada navegación: `/api/rrhh/perfil` es un endpoint que ya existe
  // (lo usa /mi-perfil) y devuelve el enlace firmado del rostro; si falta la migración o no hay
  // foto, se queda en null y el avatar usa la inicial. Best-effort: un fallo no rompe nada.
  useEffect(() => {
    if (esLogin || esPublica || cargando || fotoPedidaRef.current) return;
    fotoPedidaRef.current = true;
    let vivo = true;
    (async () => {
      try {
        const res = await fetch("/api/rrhh/perfil", { headers: await cabecerasErp() });
        const d = await res.json().catch(() => null);
        const url = d?.perfil?.foto_url_firmada;
        if (vivo && typeof url === "string" && url) setFotoPerfil(url);
      } catch { /* la inicial del avatar sirve igual */ }
    })();
    return () => { vivo = false; };
  }, [esLogin, esPublica, cargando]);

  // Al marcar ENTRADA, la pantalla de fichaje dispara este evento `window` (el mismo que
  // desbloquea el gate de la cámara, lib/rrhh/fichador.ts): desmarca el pendiente sin recargar,
  // así el recordatorio desaparece en cuanto la persona ficha. Se registra una vez por montaje.
  useEffect(() => {
    const alMarcarEntrada = () => setFichajePendiente(false);
    window.addEventListener(EVENTO_ENTRADA_MARCADA, alMarcarEntrada);
    return () => window.removeEventListener(EVENTO_ENTRADA_MARCADA, alMarcarEntrada);
  }, []);

  async function cerrarSesion() {
    try { await supabase.auth.signOut(); }
    catch (error) { console.error("Error al cerrar sesión:", error); }
    finally { window.location.href = "/login"; }
  }

  return (
    <html lang="es" className={`${manrope.variable} ${jetbrainsMono.variable}`}>
      <body>
        {esLogin ? (
          <div className="min-h-screen flex items-center justify-center bg-[#eef3f8] px-4">
            <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl">
              {children}
            </div>
          </div>

        ) : esPublica ? (
          <div style={{ margin: 0, padding: 0, height: "100dvh" }}>{children}</div>

        ) : cargando ? (
          <div className="min-h-screen flex items-center justify-center bg-[#eef3f8]">
            <div className="text-center">
              <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-gray-300 border-t-[#0b315f]" />
              <p className="font-bold text-[#0b315f]">Validando permisos...</p>
            </div>
          </div>

        ) : (
          <div className="min-h-dvh flex bg-[#eef3f8]">

            {/*
              El aside mide el alto VISIBLE y se queda pegado arriba (sticky): con ~54 ítems
              y sin alto propio estiraba el documento más allá de la pantalla, y en /monitoreo
              aparecía un hueco en blanco enorme al desplazar. El menú scrollea por dentro
              (nav con min-h-0); el documento sigue siendo el que scrollea en el resto del ERP.
              `sticky` crea su propio contexto de apilamiento: z-20 es el z que ya tenía el
              botón de colapsar, así sigue tapando lo mismo que antes y todo modal (z-40+) lo
              sigue cubriendo. También es el contexto de posicionamiento de ese botón.
            */}
            <aside
              className={`
                sticky top-0 z-20 h-dvh self-start flex flex-col flex-shrink-0
                bg-gradient-to-b from-[#0c2d52] via-[#091f3a] to-[#040f1e]
                text-white shadow-2xl
                transition-all duration-300 ease-in-out
                ${menuColapsado ? "w-[64px]" : "w-[210px]"}
              `}
            >
              <button
                onClick={alternarMenu}
                className="
                  absolute -right-3 top-[68px] z-20
                  w-6 h-6 rounded-full bg-[#2f8ee9] shadow-lg
                  flex items-center justify-center
                  hover:bg-[#1262bd] transition-colors
                "
                title={menuColapsado ? "Expandir menú" : "Colapsar menú"}
              >
                {menuColapsado
                  ? <Ic.PanelOpen  size={11} strokeWidth={2} className="text-white" />
                  : <Ic.PanelClose size={11} strokeWidth={2} className="text-white" />
                }
              </button>

              <div className={`
                flex items-center border-b border-white/8
                transition-all duration-300
                ${menuColapsado ? "p-2.5 justify-center" : "p-3"}
              `}>
                <LogoAFA collapsed={menuColapsado} />
              </div>

              {!menuColapsado && (
                <div className="px-3 py-2 border-b border-white/5">
                  <div className="flex items-center gap-2 bg-white/[0.07] ring-1 ring-white/10 rounded-lg px-2.5 py-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
                    <div>
                      <p className="text-white text-[11px] font-semibold leading-none">Sistema de Gestión</p>
                      <p className="text-sky-300 text-[9px] font-bold uppercase tracking-widest mt-0.5">ERP / TMS</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="relative flex-1 min-h-0 flex flex-col">
                <nav
                  ref={montarNavMenu}
                  onScroll={medirMenu}
                  className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-2 ${menuColapsado ? "px-1.5" : "px-2"}`}
                  style={{ scrollbarWidth: "none" }}
                >
                  {/* Envoltorio solo para medir el alto del contenido (pista inferior). */}
                  <div>
                    {menuGrupos.map((g) => (
                      <GrupoMenu
                        key={g.grupo}
                        grupo={g.grupo}
                        items={g.items}
                        pathname={pathname}
                        permisos={permisos}
                        collapsed={menuColapsado}
                        badges={badgesMenu}
                      />
                    ))}
                  </div>
                </nav>
                {/* Pista de "hay más ítems abajo": la barra de scroll está oculta. Mismo tono
                    que el fondo del aside a esa altura; no captura clics. */}
                <div
                  aria-hidden="true"
                  className={`
                    pointer-events-none absolute inset-x-0 bottom-0 h-10
                    bg-gradient-to-t from-[#061326] to-transparent
                    transition-opacity duration-200
                    ${menuSigueAbajo ? "opacity-100" : "opacity-0"}
                  `}
                />
              </div>

              {/* Bloque de usuario = puerta a Mi Perfil. Al pulsarlo abre un menú con
                  "Mi Perfil" y "Cerrar sesión" (ver MenuUsuario). Antes era un avatar inerte
                  con un botón de salir suelto. */}
              <div className={`
                border-t border-white/8 bg-black/15 transition-all duration-300
                ${menuColapsado ? "p-2" : "p-2.5"}
              `}>
                <MenuUsuario
                  nombre={nombreUsuario}
                  email={emailUsuario}
                  rol={rolUsuario}
                  foto={fotoPerfil}
                  collapsed={menuColapsado}
                  onCerrarSesion={cerrarSesion}
                />
              </div>
            </aside>

            {/* El documento es el que scrollea (los window.scrollTo del ERP dependen de eso):
                el <main> normal NO es el contenedor de scroll. Solo las pantallas de mapa a
                alto completo (RUTAS_PANTALLA_COMPLETA) miden el alto visible, sin padding.
                min-w-0: un hijo ancho no empuja el layout (aquí no cambia nada visible: con
                overflow distinto de visible el mínimo automático de un ítem flex ya es 0). */}
            <main
              className={
                esPantallaCompleta
                  ? "flex-1 min-w-0 h-dvh overflow-hidden"
                  : "flex-1 min-w-0 overflow-y-auto p-6"
              }
            >
              {children}
            </main>

            {/* ELIA — asistente de operaciones (solo usuarios internos autenticados) */}
            <EliaPanel nombre={nombreUsuario} rol={rolUsuario} permisos={permisos} />

            {/* Ayuda contextual — "?" con la ficha de la pantalla actual y el glosario contable.
                Se pinta solo si la ruta tiene ficha (lib/ayuda decide), así que no estorba. */}
            <AyudaModulo />

            {/* Aviso global de mensajes de pasajeros — toast/sonido/notificación, en cualquier página */}
            {permisos.includes("seguimiento") && (
              <NotificadorMensajesPasajeros noLeidos={mensajesNoLeidos} ultimo={ultimoMensaje} />
            )}

            {/* Recordatorio de fichaje. El gate NO atrapa a nadie (fail-open): si un fichador
                navegó sin marcar su ENTRADA, se lo recordamos sin bloquear. Es un overlay APARTE
                del gate (como AyudaModulo): no toca auth, permisos ni navegación, y al marcar
                desaparece por el evento EVENTO_ENTRADA_MARCADA. Bottom-center para no chocar con
                el menú (izquierda) ni con ELIA/Ayuda (abajo a la derecha); z-30 queda bajo los
                modales (z-40+), así que un modal lo tapa. */}
            {fichajePendiente && pathname !== "/mi-perfil" && (
              <Link
                href="/mi-perfil?tab=marcar"
                className="fixed bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-xl bg-amber-500 px-3.5 py-2.5 text-[12px] font-bold text-white shadow-xl shadow-amber-900/30 hover:bg-amber-600 transition-colors"
              >
                <Ic.UserCheck size={15} strokeWidth={2.4} />
                Marca tu entrada de hoy
              </Link>
            )}
          </div>
        )}
      </body>
    </html>
  );
}