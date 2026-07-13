"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// ─── TOKENS ──────────────────────────────────────────────────────────────────
const C = {
  navy:"#0b315f", blue:"#2f8ee9", blueDeep:"#1262bd", blueTint:"#E8F1FB",
  ok:"#27AE60",   okTint:"#E8F5EC",
  danger:"#EB5757", dangerTint:"#FDECEC",
  warn:"#B07A0F",   warnTint:"#FBF1D8",
  ink:"#0c2d52",  ink2:"#1f3a5f",
  mute:"#5B6B82", mute2:"#8693A6",
  surface:"#FFFFFF", line:"#E4E7ED", line2:"#EEF1F4",
  bg:"#eef3f8",   bg2:"#f5f8fb",
};

// ─── TIPOS ───────────────────────────────────────────────────────────────────
type Reserva       = { id:number; origen:string; destino:string; fecha_servicio:string|null; hora_servicio:string|null; tipo:string; estado:string; precio_cliente:number; costo_proveedor:number; margen:number; cliente_id:number|null; vehiculo_id:number|null; conductor_id:number|null; tipo_asignacion?:string|null; empresa_tercerizada_id?:number|null; };
type Vehiculo      = { id:number; placa:string; categoria:string|null; estado:string|null; estado_operativo:string|null; kilometraje_actual:number|null; proximo_mantenimiento_km:number|null; };
type Conductor     = { id:number; nombre:string; estado:string|null; vencimiento_licencia:string|null; };
type Seguro        = { id:number; tipo:string; fecha_vencimiento:string|null; aseguradora:string|null; vehiculo_id:number|null; };
type Mantenimiento = { id:number; costo:number; tipo:string|null; proxima_fecha:string|null; estado:string|null; vehiculo_id:number|null; };
type Combustible   = { id:number; total:number; fecha:string|null; vehiculo_id:number|null; };
type DocVehiculo   = { id:number; vehiculo_id:number; tipo:string; fecha_vencimiento:string|null; };
type Neumatico     = { id:number; vehiculo_id:number|null; km_actual:number|null; km_instalacion:number|null; vida_util_km:number|null; estado:string; cocada_actual:number|null; cocada_nueva:number|null; costo_compra:number|null; };
type EmpresaTer    = { id:number; razon_social:string; estado:string; };
type DocTercero    = { id:number; empresa_id:number; tipo:string; fecha_vencimiento:string|null; };
type Factura       = { id:number; total:number; estado:string; fecha_emision:string|null; };
type Gasto         = { id:number; monto:number; categoria:string|null; fecha:string|null; };
type ServicioHoy   = { id:number; origen:string; destino:string; hora_servicio:string|null; estado:string; cliente:string; placa:string|null; conductor:string|null; };
type AlertaSOS     = { id:number; reserva_id:number|null; lat:number|null; lng:number|null; motivo:string|null; estado:string; atendida_por:number|null; atendida_at:string|null; created_at:string; };

// ─── ICONOS LOCALES ───────────────────────────────────────────────────────────
type IP = { size?:number; sw?:number; color?:string; className?:string };
function Svg({ children, size=16, sw=2, color="currentColor", className="" }: IP & { children:React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={{ display:"block" }}>
      {children}
    </svg>
  );
}
const I = {
  CalRange:  (p:IP) => <Svg {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h2v4H8z"/><path d="M14 14h2v4h-2z"/></Svg>,
  Receipt:   (p:IP) => <Svg {...p}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></Svg>,
  TrendUp:   (p:IP) => <Svg {...p}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></Svg>,
  TrendDown: (p:IP) => <Svg {...p}><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></Svg>,
  FileCheck: (p:IP) => <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/></Svg>,
  Bus:       (p:IP) => <Svg {...p}><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></Svg>,
  UserCheck: (p:IP) => <Svg {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></Svg>,
  Users:     (p:IP) => <Svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></Svg>,
  FileText:  (p:IP) => <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></Svg>,
  Calendar:  (p:IP) => <Svg {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></Svg>,
  Circle:    (p:IP) => <Svg {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></Svg>,
  Fuel:      (p:IP) => <Svg {...p}><line x1="3" y1="22" x2="15" y2="22"/><line x1="4" y1="9" x2="14" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/></Svg>,
  Shield:    (p:IP) => <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></Svg>,
  Hand:      (p:IP) => <Svg {...p}><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></Svg>,
  Wrench:    (p:IP) => <Svg {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></Svg>,
  Radio:     (p:IP) => <Svg {...p}><circle cx="12" cy="12" r="2"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/></Svg>,
  Download:  (p:IP) => <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></Svg>,
  Bell:      (p:IP) => <Svg {...p}><path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2v1h16v-1l-2-2z"/><path d="M10 20a2 2 0 0 0 4 0"/></Svg>,
  MoreH:     (p:IP) => <Svg {...p}><circle cx="5" cy="12" r="1.2" fill={p.color||"currentColor"} stroke="none"/><circle cx="12" cy="12" r="1.2" fill={p.color||"currentColor"} stroke="none"/><circle cx="19" cy="12" r="1.2" fill={p.color||"currentColor"} stroke="none"/></Svg>,
  Arrow:     (p:IP) => <Svg {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></Svg>,
  Chev:      (p:IP) => <Svg {...p}><polyline points="9 18 15 12 9 6"/></Svg>,
  Building:  (p:IP) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18"/><path d="M9 21V9"/></Svg>,
  Fine:      (p:IP) => <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="11.01"/><line x1="12" y1="14" x2="12" y2="17"/></Svg>,
  AlertTri:  (p:IP) => <Svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></Svg>,
};

// ─── SEMÁFORO ─────────────────────────────────────────────────────────────────
type SemaforoEstado = "verde" | "amarillo" | "rojo";
function calcSemaforo(v: Vehiculo, mants: Mantenimiento[]): { estado: SemaforoEstado; razon: string } {
  if (v.estado === "inactivo")     return { estado: "rojo",     razon: "Inactivo" };
  if (v.estado === "mantenimiento") return { estado: "rojo",    razon: "En taller" };
  if (v.estado_operativo === "no_apto") return { estado: "rojo", razon: "Doc. vencido" };
  const km = Number(v.kilometraje_actual || 0);
  const proxKm = Number(v.proximo_mantenimiento_km || 0);
  const kmRest = proxKm > 0 ? proxKm - km : null;
  const hoy = new Date();
  const mantVencido = mants.filter(m => m.vehiculo_id === v.id && m.proxima_fecha)
    .some(m => new Date(m.proxima_fecha!) < hoy && m.estado !== "finalizado");
  if (mantVencido || (kmRest !== null && kmRest < 0))
    return { estado: "rojo", razon: kmRest !== null && kmRest < 0 ? "KM vencido" : "Mant. vencido" };
  const proxAlerta = mants.filter(m => m.vehiculo_id === v.id && m.proxima_fecha)
    .some(m => { const d = Math.ceil((new Date(m.proxima_fecha!).getTime() - hoy.getTime()) / 86400000); return d >= 0 && d <= 15; });
  if ((kmRest !== null && kmRest <= 1000) || proxAlerta)
    return { estado: "amarillo", razon: kmRest !== null ? `${kmRest.toLocaleString()} km` : "Serv. próximo" };
  return { estado: "verde", razon: kmRest !== null ? `${kmRest.toLocaleString()} km libres` : "Operativo" };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function estadoFecha(f: string | null): "vigente" | "por_vencer" | "vencido" | "sin_fecha" {
  const d = diasPara(f);
  if (d === null) return "sin_fecha";
  if (d < 0)     return "vencido";
  if (d <= 30)   return "por_vencer";
  return "vigente";
}
function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
const DOCS_OBL = ["SOAT", "Revisión Técnica (CITV)", "Habilitación SUTRAN", "Permiso Operación MTC"];

// ─── ÁTOMOS ───────────────────────────────────────────────────────────────────
function Card({ children, pad = 18, style = {}, onClick }: {
  children: React.ReactNode; pad?: number; style?: React.CSSProperties; onClick?: () => void;
}) {
  return (
    <div onClick={onClick}
      style={{
        background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14,
        boxShadow: "0 1px 2px rgba(11,49,95,0.04)", padding: pad,
        cursor: onClick ? "pointer" : undefined, ...style,
      }}>
      {children}
    </div>
  );
}

function Eyebrow({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{ margin: 0, fontSize: 10.5, fontWeight: 700, color: C.mute,
      letterSpacing: 1.2, textTransform: "uppercase", ...style }}>
      {children}
    </p>
  );
}

function Metric({ children, size = 28, color = C.ink, mono = true }: {
  children: React.ReactNode; size?: number; color?: string; mono?: boolean;
}) {
  return (
    <span style={{
      fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
      fontVariantNumeric: "tabular-nums", fontWeight: 700,
      fontSize: size, color, letterSpacing: -0.6, lineHeight: 1,
    }}>
      {children}
    </span>
  );
}

function Delta({ value, invert = false }: { value: number; invert?: boolean }) {
  const up = value >= 0;
  const positive = invert ? !up : up;
  const color = positive ? C.ok : C.danger;
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color,
      display: "inline-flex", alignItems: "center", gap: 3 }}>
      {up ? "↑" : "↓"} {Math.abs(value)}%
    </span>
  );
}

function Tag({ children, color = C.ink, bg = "#F1F4F8", dot, size = "sm" }: {
  children: React.ReactNode; color?: string; bg?: string; dot?: string; size?: "sm" | "xs";
}) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontWeight: 600, fontSize: size === "xs" ? 10 : 11,
      color, background: bg, padding: size === "xs" ? "2px 7px" : "3px 9px",
      borderRadius: 999, letterSpacing: 0.1, lineHeight: 1.4, whiteSpace: "nowrap",
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 999, background: dot, flexShrink: 0 }}/>}
      {children}
    </span>
  );
}

function Ring({ value, label, color = C.navy }: { value: number; label: string; color?: string }) {
  const R = 32, circ = 2 * Math.PI * R;
  const dash = Math.max(0, Math.min(100, value)) / 100 * circ;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <svg width={80} height={80} viewBox="0 0 80 80">
        <g transform="translate(40,40) rotate(-90)">
          <circle r={R} fill="none" stroke={C.line2} strokeWidth="7"/>
          <circle r={R} fill="none" stroke={color} strokeWidth="7"
            strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"/>
        </g>
        <text x="40" y="46" textAnchor="middle"
          fontFamily="var(--font-mono)" fontSize="16" fontWeight="700" fill={C.ink}>
          {value}%
        </text>
      </svg>
      <span style={{ fontSize: 10, fontWeight: 800, color: C.mute, letterSpacing: 1, textTransform: "uppercase" }}>
        {label}
      </span>
    </div>
  );
}

function Spark({ data, color = C.navy, area = true }: { data: number[]; color?: string; area?: boolean }) {
  const id = `sp${Math.random().toString(36).slice(2, 8)}`;
  const W = 90, H = 28;
  if (!data.length) return <svg width={W} height={H}/>;
  const mx = Math.max(...data), mn = Math.min(...data), range = mx - mn || 1;
  const step = W / Math.max(data.length - 1, 1);
  const pts = data.map((v, i) => [i * step, H - 3 - ((v - mn) / range) * (H - 6)] as [number, number]);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area_ = path + ` L ${W},${H} L 0,${H} Z`;
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      {area && (
        <><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient></defs>
        <path d={area_} fill={`url(#${id})`}/></>
      )}
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function Skeleton({ h = 80, radius = 14 }: { h?: number; radius?: number }) {
  return (
    <div style={{ height: h, borderRadius: radius, background: C.line2,
      animation: "pulse 1.5s ease-in-out infinite" }}/>
  );
}

// ─── KPI CARD ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, prefix, suffix, delta, spark, sparkColor, intent = "neutral", icon: Icon, deltaInvert, onClick }: {
  label: string; value: string | number; prefix?: string; suffix?: string;
  delta?: number; spark?: number[]; sparkColor?: string;
  intent?: "neutral" | "positive" | "negative";
  icon?: (p: IP) => React.ReactElement; deltaInvert?: boolean; onClick?: () => void;
}) {
  const iconColor = intent === "positive" ? C.ok : intent === "negative" ? C.danger : C.navy;
  const iconBg    = intent === "positive" ? C.okTint : intent === "negative" ? C.dangerTint : C.blueTint;
  return (
    <Card pad={18} onClick={onClick}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <Eyebrow>{label}</Eyebrow>
        {Icon && (
          <div style={{ width: 32, height: 32, borderRadius: 9, background: iconBg, color: iconColor,
            display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon size={16} sw={2} color={iconColor}/>
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        {prefix && <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: C.mute }}>{prefix}</span>}
        <Metric size={28}>{value}</Metric>
        {suffix && <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: C.mute }}>{suffix}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 12 }}>
        {delta !== undefined
          ? <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <Delta value={delta} invert={deltaInvert}/>
              <span style={{ fontSize: 10.5, color: C.mute2, fontWeight: 500 }}>vs. mes anterior</span>
            </div>
          : <span style={{ fontSize: 10.5, color: C.mute2 }}>—</span>
        }
        {spark && <Spark data={spark} color={sparkColor || C.navy}/>}
      </div>
    </Card>
  );
}

// ─── ÁREA TILE ────────────────────────────────────────────────────────────────
function AreaTile({ icon: Icon, label, value, sub, intent = "neutral", onClick }: {
  icon: (p: IP) => React.ReactElement; label: string; value: string; sub: string;
  intent?: "neutral" | "ok" | "warn" | "danger"; onClick?: () => void;
}) {
  const color = intent === "ok" ? C.ok : intent === "danger" ? C.danger : intent === "warn" ? C.warn : C.navy;
  const iconBg = intent === "ok" ? C.okTint : intent === "danger" ? C.dangerTint : intent === "warn" ? C.warnTint : C.blueTint;
  return (
    <Card pad={14} onClick={onClick}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: iconBg, color,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={15} sw={2} color={color}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 9.5, fontWeight: 800, color: C.mute,
            letterSpacing: 1.1, textTransform: "uppercase" }}>{label}</p>
          <p style={{ margin: "6px 0 0", fontFamily: intent === "neutral" ? "var(--font-mono)" : "var(--font-sans)",
            fontSize: 17, fontWeight: 800, color: intent === "ok" ? C.ok : C.ink, letterSpacing: -0.3 }}>
            {value}
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 10.5, color: C.mute2 }}>{sub}</p>
        </div>
      </div>
    </Card>
  );
}

// ─── ALERTA ITEM ──────────────────────────────────────────────────────────────
function AlertaItem({ tipo, texto, href, router }: {
  tipo: "critico" | "atencion" | "info" | "ok"; texto: string;
  href?: string; router: ReturnType<typeof useRouter>;
}) {
  const cfg = {
    critico:  { iconEl: <I.AlertTri size={15} sw={2} color={C.danger}/>, label: "CRÍTICO",  title: C.ink, detail: C.mute, iconBg: C.dangerTint },
    atencion: { iconEl: <I.AlertTri size={15} sw={2} color={C.warn}/>,   label: "ATENCIÓN", title: C.ink, detail: C.mute, iconBg: C.warnTint },
    info:     { iconEl: <I.Bell size={15} sw={2} color={C.navy}/>,       label: "INFO",     title: C.ink, detail: C.mute, iconBg: C.blueTint },
    ok:       { iconEl: <I.FileCheck size={15} sw={2} color={C.ok}/>,    label: "OK",       title: C.ok,  detail: C.mute, iconBg: C.okTint },
  }[tipo];
  return (
    <div style={{ display: "flex", gap: 12, padding: "12px 18px",
      cursor: href ? "pointer" : undefined }}
      onClick={href ? () => router.push(href) : undefined}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: cfg.iconBg,
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {cfg.iconEl}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: cfg.title, letterSpacing: -0.1 }}>
          {cfg.label}
        </p>
        <p style={{ margin: "3px 0 0", fontSize: 11.5, color: cfg.detail, lineHeight: 1.4 }}>{texto}</p>
        {href && (
          <button style={{ marginTop: 8, padding: "5px 10px", borderRadius: 7, background: "#fff",
            border: `1px solid ${C.line}`, fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 11,
            color: C.ink, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
            Ver <I.Arrow size={11} sw={2}/>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── FINANCE CHART ────────────────────────────────────────────────────────────
function FinanceChart({ totalVentas, totalGastos, totalMargen }: {
  totalVentas: number; totalGastos: number; totalMargen: number;
}) {
  const ingresos = [12.2, 14.8, 13.1, 15.6, 16.9, 18.4, 17.2, 19.8, 21.5, 20.1, 22.3, 24.7];
  const gastos   = [8.4, 9.1, 9.8, 10.2, 11.1, 10.8, 11.6, 12.4, 13.1, 12.8, 13.5, 14.2];
  const W = 760, H = 220, P = { l: 36, r: 14, t: 14, b: 26 }, max = 28;
  const xs = (i: number) => P.l + (i / (ingresos.length - 1)) * (W - P.l - P.r);
  const ys = (v: number) => H - P.b - (v / max) * (H - P.t - P.b);
  const pathFrom = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const areaIng = pathFrom(ingresos) + ` L ${xs(ingresos.length-1)},${H-P.b} L ${xs(0)},${H-P.b} Z`;
  const labels = ["S14","S15","S16","S17","S18","S19","S20","S21","S22","S23","S24","S25"];
  const li = ingresos.length - 1;
  const margenPct = totalVentas > 0 ? ((totalMargen / totalVentas) * 100).toFixed(1) : "0.0";

  return (
    <Card pad={20} style={{ gridColumn: "span 8" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <Eyebrow>Finanzas · últimas 12 semanas</Eyebrow>
          <h3 style={{ margin: "6px 0 0", fontFamily: "var(--font-sans)", fontWeight: 800, fontSize: 17, color: C.ink, letterSpacing: -0.3 }}>
            Ingresos vs. Gastos
          </h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: C.ink2 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: C.ok }}/>Ingresos
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: C.ink2 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: C.danger }}/>Gastos
          </span>
          <div style={{ display: "inline-flex", background: C.bg2, border: `1px solid ${C.line}`, borderRadius: 8, padding: 2 }}>
            {["7d","4s","12s","YTD"].map((p, i) => (
              <button key={p} style={{ padding: "4px 10px", border: "none", cursor: "pointer",
                background: i === 2 ? C.surface : "transparent",
                color: i === 2 ? C.ink : C.mute,
                borderRadius: 6, fontSize: 11, fontWeight: 700,
                boxShadow: i === 2 ? "0 1px 2px rgba(11,49,95,0.06)" : "none" }}>
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        <defs>
          <linearGradient id="ing-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.ok} stopOpacity="0.18"/>
            <stop offset="100%" stopColor={C.ok} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[0,1,2,3,4].map(i => {
          const y = P.t + ((H - P.t - P.b) * i) / 4;
          const v = max - (max / 4) * i;
          return (
            <g key={i}>
              <line x1={P.l} x2={W-P.r} y1={y} y2={y} stroke={C.line2} strokeWidth="1"/>
              <text x={P.l-6} y={y+3} textAnchor="end" fontFamily="var(--font-mono)"
                fontSize="10" fill={C.mute2} fontWeight="600">{v.toFixed(0)}k</text>
            </g>
          );
        })}
        {labels.map((l, i) => (
          <text key={l} x={xs(i)} y={H-8} textAnchor="middle"
            fontFamily="var(--font-mono)" fontSize="10" fill={C.mute2} fontWeight="600">{l}</text>
        ))}
        <path d={areaIng} fill="url(#ing-area)"/>
        <path d={pathFrom(ingresos)} fill="none" stroke={C.ok} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d={pathFrom(gastos)}   fill="none" stroke={C.danger} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx={xs(li)} cy={ys(ingresos[li])} r="4.5" fill="#fff" stroke={C.ok} strokeWidth="2.5"/>
        <circle cx={xs(li)} cy={ys(gastos[li])}   r="4.5" fill="#fff" stroke={C.danger} strokeWidth="2.5"/>
        <g transform={`translate(${xs(li)-80},${ys(ingresos[li])-38})`}>
          <rect x="0" y="0" width="74" height="32" rx="7" fill={C.ink}/>
          <text x="8" y="13" fontFamily="var(--font-sans)" fontSize="9" fill="rgba(255,255,255,0.6)" fontWeight="600" letterSpacing="0.8">S25 · INGRESO</text>
          <text x="8" y="26" fontFamily="var(--font-mono)" fontSize="12" fill="#fff" fontWeight="700">S/ 24.7k</text>
        </g>
      </svg>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line2}`,
        display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20 }}>
        <div>
          <Eyebrow>Ingresos · mes</Eyebrow>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
            <Metric size={20}>{fmtSoles(totalVentas)}</Metric>
          </div>
        </div>
        <div>
          <Eyebrow>Gastos · mes</Eyebrow>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
            <Metric size={20}>{fmtSoles(totalGastos)}</Metric>
          </div>
        </div>
        <div>
          <Eyebrow>Margen</Eyebrow>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
            <Metric size={20} color={C.ok}>{fmtSoles(totalMargen)}</Metric>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: C.ok }}>{margenPct}%</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── FLEET DONUT ─────────────────────────────────────────────────────────────
function FleetDonut({ vehiculos }: { vehiculos: Vehiculo[] }) {
  const enRuta       = vehiculos.filter(v => v.estado === "activo" || v.estado === "disponible").length;
  const disponible   = vehiculos.filter(v => v.estado === "disponible").length;
  const mantenimiento= vehiculos.filter(v => v.estado === "mantenimiento").length;
  const fueraServicio= vehiculos.filter(v => v.estado === "inactivo").length;
  const total        = vehiculos.length || 1;
  const segments = [
    { label: "En ruta",        value: Math.max(0, enRuta - disponible), color: C.ok },
    { label: "Disponible",     value: disponible,   color: C.navy },
    { label: "Mantenimiento",  value: mantenimiento, color: C.warn },
    { label: "Fuera servicio", value: fueraServicio, color: C.danger },
  ];
  const R = 58, circ = 2 * Math.PI * R;
  let offset = 0;
  return (
    <Card pad={20} style={{ gridColumn: "span 4" }}>
      <Eyebrow>Flota · estado actual</Eyebrow>
      <h3 style={{ margin: "6px 0 16px", fontFamily: "var(--font-sans)", fontWeight: 800, fontSize: 17, color: C.ink, letterSpacing: -0.3 }}>
        {vehiculos.length} unidades
      </h3>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <svg width={150} height={150} viewBox="0 0 150 150" style={{ flexShrink: 0 }}>
          <g transform="translate(75,75) rotate(-90)">
            <circle r={R} fill="none" stroke={C.line2} strokeWidth="14"/>
            {segments.map((s, idx) => {
              const len = (s.value / total) * circ;
              const el = (
                <circle key={idx} r={R} fill="none" stroke={s.color} strokeWidth="14"
                  strokeDasharray={`${len} ${circ-len}`} strokeDashoffset={-offset} strokeLinecap="butt"/>
              );
              offset += len;
              return el;
            })}
          </g>
          <text x="75" y="71" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="26" fontWeight="700" fill={C.ink}>{vehiculos.length}</text>
          <text x="75" y="89" textAnchor="middle" fontFamily="var(--font-sans)" fontSize="10" fontWeight="600" fill={C.mute} letterSpacing="1">UNIDADES</text>
        </svg>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
          {segments.map(s => (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }}/>
              <span style={{ flex: 1, fontSize: 11.5, fontWeight: 600, color: C.ink2 }}>{s.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: C.ink }}>{s.value}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600, color: C.mute2, width: 32, textAlign: "right" }}>
                {((s.value / total) * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const router = useRouter();

  const [reservas,      setReservas]      = useState<Reserva[]>([]);
  const [vehiculos,     setVehiculos]     = useState<Vehiculo[]>([]);
  const [conductores,   setConductores]   = useState<Conductor[]>([]);
  const [seguros,       setSeguros]       = useState<Seguro[]>([]);
  const [mantenimiento, setMantenimiento] = useState<Mantenimiento[]>([]);
  const [combustible,   setCombustible]   = useState<Combustible[]>([]);
  const [docsVehiculo,  setDocsVehiculo]  = useState<DocVehiculo[]>([]);
  const [neumaticos,    setNeumaticos]    = useState<Neumatico[]>([]);
  const [empresasTer,   setEmpresasTer]   = useState<EmpresaTer[]>([]);
  const [docsTercero,   setDocsTercero]   = useState<DocTercero[]>([]);
  const [facturas,      setFacturas]      = useState<Factura[]>([]);
  const [gastos,        setGastos]        = useState<Gasto[]>([]);
  const [serviciosHoy,  setServiciosHoy]  = useState<ServicioHoy[]>([]);
  const [alertasSOS,    setAlertasSOS]    = useState<AlertaSOS[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [modulo,        setModulo]        = useState<"erp"|"apps">("erp");

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const safe = async (q: Promise<{ data: any; error: any }>) => {
          const r = await q;
          if (r.error) { console.warn("Dashboard:", r.error.message); return { data: [] }; }
          return r;
        };
        const hoy = new Date().toISOString().split("T")[0];
        const [rRes,vRes,cRes,sRes,mRes,cbRes,dvRes,nRes,etRes,dtRes,fRes,gRes,shRes,sosRes] = await Promise.all([
          safe(supabase.from("reservas").select("id,origen,destino,fecha_servicio,hora_servicio,tipo,estado,precio_cliente,costo_proveedor,margen,cliente_id,vehiculo_id,conductor_id,tipo_asignacion,empresa_tercerizada_id").order("id", { ascending: false })),
          safe(supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,kilometraje_actual,proximo_mantenimiento_km")),
          safe(supabase.from("conductores").select("id,nombre,estado,vencimiento_licencia")),
          safe(supabase.from("seguros").select("id,tipo,fecha_vencimiento,aseguradora,vehiculo_id")),
          safe(supabase.from("mantenimiento").select("id,costo,tipo,proxima_fecha,estado,vehiculo_id")),
          safe(supabase.from("combustible").select("id,total,fecha,vehiculo_id")),
          safe(supabase.from("documentos_vehiculo").select("id,vehiculo_id,tipo,fecha_vencimiento")),
          safe(supabase.from("neumaticos").select("id,vehiculo_id,km_actual,km_instalacion,vida_util_km,estado,cocada_actual,cocada_nueva,costo_compra")),
          safe(supabase.from("empresas_tercerizadas").select("id,razon_social,estado")),
          safe(supabase.from("documentos_tercero").select("id,empresa_id,tipo,fecha_vencimiento")),
          safe(supabase.from("facturas").select("id,total,estado,fecha_emision")),
          safe(supabase.from("gastos").select("id,monto,categoria,fecha")),
          safe(supabase.from("reservas").select("id,origen,destino,hora_servicio,estado,cliente:clientes(nombre,empresa),vehiculo:vehiculos(placa),conductor:conductores(nombre)").eq("fecha_servicio", hoy).order("hora_servicio")),
          safe(supabase.from("alertas_sos").select("*").eq("estado", "pendiente").order("created_at", { ascending: false })),
        ]);
        setReservas(rRes.data      || []);
        setVehiculos(vRes.data     || []);
        setConductores(cRes.data   || []);
        setSeguros(sRes.data       || []);
        setMantenimiento(mRes.data || []);
        setCombustible(cbRes.data  || []);
        setDocsVehiculo(dvRes.data || []);
        setNeumaticos(nRes.data    || []);
        setEmpresasTer(etRes.data  || []);
        setDocsTercero(dtRes.data  || []);
        setFacturas(fRes.data      || []);
        setGastos(gRes.data        || []);
        setAlertasSOS((sosRes.data || []) as AlertaSOS[]);
        setServiciosHoy(((shRes.data || []) as any[]).map(r => ({
          id: r.id, origen: r.origen, destino: r.destino,
          hora_servicio: r.hora_servicio, estado: r.estado,
          cliente: r.cliente?.empresa || r.cliente?.nombre || "Sin cliente",
          placa: r.vehiculo?.placa || null,
          conductor: r.conductor?.nombre || null,
        })));
      } catch (e) { console.error("Dashboard error:", e); }
      finally { setLoading(false); }
    })();

    const ch = supabase.channel("dashboard-sos")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alertas_sos" },
        (payload: { new: AlertaSOS }) => { setAlertasSOS(prev => [payload.new, ...prev]); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "alertas_sos" },
        (payload: { new: AlertaSOS }) => { setAlertasSOS(prev => prev.map(a => a.id === payload.new.id ? payload.new : a)); })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "alertas_sos" },
        (payload: { old: { id: number } }) => { setAlertasSOS(prev => prev.filter(a => a.id !== payload.old.id)); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // ── Cálculos ────────────────────────────────────────────────────────────────
  const alertasPendientesSOS = alertasSOS.filter(a => a.estado === "pendiente");
  const sosActivos   = alertasPendientesSOS.length;
  const hoy          = new Date().toISOString().split("T")[0];
  const resHoy       = reservas.filter(r => r.fecha_servicio === hoy);
  const pendientes   = reservas.filter(r => r.estado === "pendiente");
  const programadas  = reservas.filter(r => r.estado === "programada");
  const confirmadas  = reservas.filter(r => r.estado === "confirmada");
  const finalizadas  = reservas.filter(r => r.estado === "finalizada");
  const canceladas   = reservas.filter(r => r.estado === "cancelada");
  const tercerizadas = reservas.filter(r => r.tipo === "tercerizada");
  const maxEstado    = Math.max(pendientes.length, confirmadas.length, finalizadas.length, canceladas.length, 1);

  const totalVentas      = reservas.reduce((s,r) => s + Number(r.precio_cliente||0), 0);
  const totalMargen      = reservas.reduce((s,r) => s + Number(r.margen||0), 0);
  const totalFacturado   = facturas.reduce((s,f) => s + Number(f.total||0), 0);
  const totalGastosGen   = gastos.reduce((s,g) => s + Number(g.monto||0), 0);
  const gastoCombustible = combustible.reduce((s,c) => s + Number(c.total||0), 0);
  const gastoManten      = mantenimiento.reduce((s,m) => s + Number(m.costo||0), 0);
  const utilidad         = totalFacturado - totalGastosGen;
  const margenPct        = totalVentas > 0 ? Math.round((totalMargen/totalVentas)*100) : 0;
  const avanceFact       = totalVentas > 0 ? Math.min(100, Math.round((totalFacturado/totalVentas)*100)) : 0;

  const datosFlota = vehiculos.map(v => ({ vehiculo: v, semaforo: calcSemaforo(v, mantenimiento) }));
  const verdes     = datosFlota.filter(d => d.semaforo.estado === "verde").length;
  const amarillos  = datosFlota.filter(d => d.semaforo.estado === "amarillo").length;
  const rojos      = datosFlota.filter(d => d.semaforo.estado === "rojo").length;
  const dispMecan  = vehiculos.length > 0 ? Math.round((verdes / vehiculos.length) * 100) : 0;
  const costoFlota = combustible.reduce((s,c) => s+Number(c.total||0), 0) + mantenimiento.reduce((s,m) => s+Number(m.costo||0), 0);
  const kmFlota    = vehiculos.reduce((s,v) => s+Number(v.kilometraje_actual||0), 0);
  const cpkFlota   = kmFlota > 0 ? costoFlota / kmFlota : 0;

  const condDisp    = conductores.filter(c => c.estado === "disponible").length;
  const licVenc     = conductores.filter(c => estadoFecha(c.vencimiento_licencia) === "vencido").length;
  const licPorVenc  = conductores.filter(c => estadoFecha(c.vencimiento_licencia) === "por_vencer").length;

  const docsVenc    = docsVehiculo.filter(d => estadoFecha(d.fecha_vencimiento) === "vencido").length;
  const docsPorVenc = docsVehiculo.filter(d => estadoFecha(d.fecha_vencimiento) === "por_vencer").length;
  const docsOblVenc = docsVehiculo.filter(d => DOCS_OBL.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "vencido").length;

  const neuActivos  = neumaticos.filter(n => n.estado === "activo");
  const neuCrit     = neuActivos.filter(n => { const km=Number(n.km_actual||0)-Number(n.km_instalacion||0); const v=Number(n.vida_util_km||80000); return v>0&&(km/v)>=0.9; }).length;
  const neuPorVenc  = neuActivos.filter(n => { const km=Number(n.km_actual||0)-Number(n.km_instalacion||0); const v=Number(n.vida_util_km||80000); const pct=v>0?km/v:0; return pct>=0.7&&pct<0.9; }).length;
  const cpkNeuArr   = neuActivos.filter(n=>n.costo_compra&&n.km_actual&&n.km_instalacion).map(n => { const km=Number(n.km_actual)-Number(n.km_instalacion); return km>0?Number(n.costo_compra)/km:null; }).filter(Boolean) as number[];
  const cpkNeuProm  = cpkNeuArr.length > 0 ? cpkNeuArr.reduce((a,b)=>a+b)/cpkNeuArr.length : null;

  const segVenc     = seguros.filter(s => estadoFecha(s.fecha_vencimiento) === "vencido").length;
  const segPorVenc  = seguros.filter(s => estadoFecha(s.fecha_vencimiento) === "por_vencer").length;
  const segOblVenc  = seguros.filter(s => ["soat","cat","sctr_salud","sctr_pension","vida_ley"].includes(s.tipo) && estadoFecha(s.fecha_vencimiento) === "vencido").length;

  const mantPend    = mantenimiento.filter(m => m.estado === "pendiente").length;
  const mantProx    = mantenimiento.filter(m => { const d=diasPara(m.proxima_fecha); return d!==null&&d>=0&&d<=15; }).length;

  const empConRiesgo = empresasTer.filter(e => docsTercero.filter(d=>d.empresa_id===e.id).some(d=>DOCS_OBL.includes(d.tipo)&&estadoFecha(d.fecha_vencimiento)==="vencido")).length;
  const empPorVenc   = empresasTer.filter(e => !docsTercero.filter(d=>d.empresa_id===e.id).some(d=>DOCS_OBL.includes(d.tipo)&&estadoFecha(d.fecha_vencimiento)==="vencido")&&docsTercero.filter(d=>d.empresa_id===e.id).some(d=>DOCS_OBL.includes(d.tipo)&&estadoFecha(d.fecha_vencimiento)==="por_vencer")).length;

  // ── Alertas ─────────────────────────────────────────────────────────────────
  type Alerta = { tipo: "critico"|"atencion"|"info"|"ok"; texto: string; href?: string; orden: number };
  const alertas: Alerta[] = [];
  if (sosActivos>0)          alertas.push({ tipo:"critico",  texto:`${sosActivos} ALERTA(S) SOS activa(s) sin atender`,                     href:"/monitoreo",               orden:0 });
  if (docsOblVenc>0)         alertas.push({ tipo:"critico",  texto:`${docsOblVenc} doc. obligatorio vencido (SOAT, CITV, SUTRAN)`,           href:"/documentos-vehiculares",  orden:1 });
  if (segOblVenc>0)          alertas.push({ tipo:"critico",  texto:`${segOblVenc} seguro obligatorio vencido (SCTR, Vida Ley)`,              href:"/seguros",                 orden:2 });
  if (empConRiesgo>0)        alertas.push({ tipo:"critico",  texto:`${empConRiesgo} empresa tercerizada con documentos vencidos`,            href:"/tercerizadas",            orden:3 });
  if (licVenc>0)             alertas.push({ tipo:"critico",  texto:`${licVenc} conductor(es) con licencia vencida`,                         href:"/conductores",             orden:4 });
  if (neuCrit>0)             alertas.push({ tipo:"critico",  texto:`${neuCrit} neumático(s) al 90%+ de vida útil`,                          href:"/neumaticos",              orden:5 });
  if (rojos>0)               alertas.push({ tipo:"critico",  texto:`${rojos} vehículo(s) en estado crítico`,                                href:"/vehiculos",               orden:6 });
  if (pendientes.length>0)   alertas.push({ tipo:"atencion", texto:`${pendientes.length} reserva(s) pendiente(s) de programar`,             href:"/reservas",                orden:10 });
  if (docsVenc>0)            alertas.push({ tipo:"atencion", texto:`${docsVenc} documento(s) de vehículo vencido(s)`,                       href:"/documentos-vehiculares",  orden:11 });
  if (segPorVenc>0)          alertas.push({ tipo:"atencion", texto:`${segPorVenc} seguro(s) vence(n) en 30 días`,                           href:"/seguros",                 orden:12 });
  if (licPorVenc>0)          alertas.push({ tipo:"atencion", texto:`${licPorVenc} licencia(s) de conductor por vencer`,                     href:"/conductores",             orden:13 });
  if (mantPend>0)            alertas.push({ tipo:"atencion", texto:`${mantPend} mantenimiento(s) pendiente(s)`,                             href:"/mantenimiento?tab=historial",           orden:14 });
  if (mantProx>0)            alertas.push({ tipo:"atencion", texto:`${mantProx} mantenimiento(s) en 15 días`,                               href:"/mantenimiento?tab=historial",           orden:15 });
  if (neuPorVenc>0)          alertas.push({ tipo:"atencion", texto:`${neuPorVenc} neumático(s) entre 70–90% de vida útil`,                  href:"/neumaticos",              orden:16 });
  if (empPorVenc>0)          alertas.push({ tipo:"atencion", texto:`${empPorVenc} empresa(s) tercerizada(s) con docs por vencer`,           href:"/tercerizadas",            orden:17 });
  if (amarillos>0)           alertas.push({ tipo:"atencion", texto:`${amarillos} vehículo(s) próximo(s) a mantenimiento`,                   href:"/vehiculos",               orden:18 });
  if (resHoy.length>0)       alertas.push({ tipo:"info",     texto:`${resHoy.length} servicio(s) programado(s) para hoy`,                   href:"/reservas",                orden:20 });
  if (tercerizadas.length>0) alertas.push({ tipo:"info",     texto:`${tercerizadas.length} reserva(s) tercerizada(s) en cartera`,           href:"/reservas",                orden:21 });
  if (alertas.length===0)    alertas.push({ tipo:"ok",       texto:"Operación estable · Sin alertas críticas detectadas",                                                    orden:99 });
  alertas.sort((a,b) => a.orden - b.orden);
  const alertasCrit = alertas.filter(a => a.tipo === "critico");
  const alertasAten = alertas.filter(a => a.tipo === "atencion");
  const alertasInfo = alertas.filter(a => a.tipo === "info" || a.tipo === "ok");

  const scoreRiesgo = Math.min(100, alertasCrit.length * 20 + alertasAten.length * 5);
  const nivelRiesgo = scoreRiesgo === 0 ? "Bajo" : scoreRiesgo <= 20 ? "Moderado" : scoreRiesgo <= 50 ? "Alto" : "Crítico";
  const colorRiesgo = scoreRiesgo === 0 ? C.ok : scoreRiesgo <= 20 ? C.warn : C.danger;
  const bgRiesgo    = scoreRiesgo === 0 ? C.okTint : scoreRiesgo <= 20 ? C.warnTint : C.dangerTint;

  // ── Docs próximos ────────────────────────────────────────────────────────────
  const proxDocs = docsVehiculo
    .filter(d => { const dias=diasPara(d.fecha_vencimiento); return dias!==null&&dias>=-7&&dias<=30; })
    .sort((a,b) => (diasPara(a.fecha_vencimiento)||0) - (diasPara(b.fecha_vencimiento)||0))
    .slice(0, 6);

  // ── Mantenimientos próximos ───────────────────────────────────────────────────
  const mantProximos = mantenimiento
    .filter(m => m.proxima_fecha && m.estado !== "finalizado")
    .sort((a,b) => new Date(a.proxima_fecha!).getTime() - new Date(b.proxima_fecha!).getTime())
    .slice(0, 6);

  // ── Estado áreas ─────────────────────────────────────────────────────────────
  const areaIntentDoc  = docsOblVenc>0 ? "danger" : docsPorVenc>0 ? "warn" : "ok" as "danger"|"warn"|"ok"|"neutral";
  const areaIntentNeu  = neuCrit>0 ? "danger" : neuPorVenc>0 ? "warn" : "ok" as "danger"|"warn"|"ok"|"neutral";
  const areaIntentSeg  = segOblVenc>0 ? "danger" : segPorVenc>0 ? "warn" : "ok" as "danger"|"warn"|"ok"|"neutral";
  const areaIntentMant = mantPend>0 ? "warn" : "ok" as "danger"|"warn"|"ok"|"neutral";

  const estadoBadge: Record<string, { bg: string; c: string; dot: string }> = {
    pendiente:  { bg:"#fef9c3", c:"#854d0e", dot:"#eab308" },
    programada: { bg:"#e0f2fe", c:"#0369a1", dot:"#0284c7" },
    confirmada: { bg: C.okTint, c: C.ok, dot: C.ok },
    en_curso:   { bg:"#dbeafe", c:"#1d4ed8", dot:"#2563eb" },
    finalizada: { bg:"#ede9fe", c:"#6d28d9", dot:"#7c3aed" },
    cancelada:  { bg: C.dangerTint, c: C.danger, dot: C.danger },
  };

  // ── Cumplimiento del día ─────────────────────────────────────────────────────
  const totalHoy   = serviciosHoy.length;
  const asignadosHoy  = serviciosHoy.filter(s => s.placa && s.conductor).length;
  const completadosHoy= serviciosHoy.filter(s => s.estado === "finalizada" || s.estado === "completado").length;
  const pctAsig  = totalHoy > 0 ? Math.round((asignadosHoy/totalHoy)*100) : 100;
  const pctComp  = totalHoy > 0 ? Math.round((completadosHoy/totalHoy)*100) : 0;

  // ─── LOADING ─────────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: "22px 28px" }}>
      <div style={{ display: "grid", gap: 14, marginBottom: 14 }}>
        <Skeleton h={56}/>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
          <Skeleton h={72}/><Skeleton h={72}/><Skeleton h={72}/>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14 }}>
          {[1,2,3,4,5].map(i => <Skeleton key={i} h={110}/>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14 }}>
          {[1,2,3,4,5].map(i => <Skeleton key={i} h={110}/>)}
        </div>
      </div>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );

  // ─── RENDER ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: "22px 28px 40px", fontFamily: "var(--font-sans)" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>

      {/* ── 1. HEADER ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
        <div>
          <Eyebrow>Resumen · {new Date().toLocaleDateString("es-PE", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</Eyebrow>
          <h1 style={{ margin: "6px 0 0", fontFamily: "var(--font-sans)", fontWeight: 800, fontSize: 26, color: C.ink, letterSpacing: -0.6 }}>
            Dashboard
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.mute, fontWeight: 500 }}>
            {serviciosHoy.length > 0 && `${serviciosHoy.length} servicios hoy · `}
            {alertasCrit.length > 0 ? `${alertasCrit.length} alerta(s) crítica(s)` : "Sin alertas críticas"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
          {/* Module switcher */}
          <div style={{ display: "inline-flex", background: C.surface, border: `1px solid ${C.line}`, borderRadius: 9, padding: 3 }}>
            {(["erp","apps"] as const).map(t => (
              <button key={t} onClick={() => setModulo(t)}
                style={{ padding: "6px 12px", border: "none", cursor: "pointer", borderRadius: 7,
                  background: modulo === t ? C.navy : "transparent",
                  color: modulo === t ? "#fff" : C.mute,
                  fontSize: 12, fontWeight: 700, fontFamily: "var(--font-sans)" }}>
                {t === "erp" ? "ERP" : "Apps móviles"}
              </button>
            ))}
          </div>
          {/* Monitoreo GPS */}
          <button onClick={() => router.push("/monitoreo")}
            style={{ padding: "6px 14px", borderRadius: 9, background: C.surface,
              border: `1px solid ${C.line}`, cursor: "pointer", display: "inline-flex",
              alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: C.ink,
              fontFamily: "var(--font-sans)" }}>
            <I.Radio size={13} sw={2} color={C.ink}/> Monitoreo GPS
          </button>
          {/* Riesgo operativo */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface,
            border: `1px solid ${C.line}`, borderRadius: 9, padding: "6px 10px 6px 12px" }}>
            <div>
              <span style={{ display: "block", fontSize: 9, fontWeight: 800, color: C.mute,
                letterSpacing: 1.2, textTransform: "uppercase" }}>Riesgo operativo</span>
              <span style={{ display: "block", fontSize: 13, fontWeight: 800, color: C.ink, marginTop: 1 }}>
                {nivelRiesgo}
              </span>
            </div>
            <div style={{ width: 26, height: 26, borderRadius: 999, background: bgRiesgo,
              display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: 10, height: 10, borderRadius: 999, background: colorRiesgo }}/>
            </div>
          </div>
        </div>
      </div>

      {/* ── SOS BANNER ── */}
      {sosActivos > 0 && (
        <div style={{ borderRadius: 14, border: `2px solid ${C.danger}`, padding: "14px 18px",
          display: "flex", alignItems: "center", gap: 14, marginBottom: 14,
          background: "#1c0202", animation: "pulse 1.5s ease-in-out infinite" }}>
          <I.AlertTri size={28} sw={2.5} color={C.danger}/>
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, color: C.danger, fontWeight: 800, fontSize: 15 }}>
              ALERTA SOS ACTIVA — {sosActivos} sin atender
            </p>
            {alertasPendientesSOS[0] && <p style={{ margin: "3px 0 0", color: "#b91c1c", fontSize: 12 }}>{alertasPendientesSOS[0].motivo}</p>}
          </div>
          <button onClick={() => router.push("/monitoreo")}
            style={{ padding: "9px 18px", borderRadius: 9, background: C.danger, border: "none",
              color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", flexShrink: 0,
              fontFamily: "var(--font-sans)" }}>
            Atender →
          </button>
        </div>
      )}

      {/* ── 2. PORTAL QUICK-ACCESS ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 14 }}>
        {[
          { href:"/pasajero",  title:"App Pasajero",       sub:"Portal para pasajeros · login con DNI", Icon:I.Users },
          { href:"/conductor", title:"App Conductor",      sub:"App para choferes · DNI + PIN",         Icon:I.UserCheck },
          { href:"/cliente",   title:"Portal Empresarial", sub:"Reportes de boarding para clientes",    Icon:I.Building },
        ].map(p => (
          <a key={p.href} href={p.href} target="_blank" rel="noreferrer"
            style={{ textDecoration: "none", display: "block" }}>
            <Card pad={16}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: 11, background: C.blueTint,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <p.Icon size={20} sw={2} color={C.navy}/>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: C.ink, letterSpacing: -0.2 }}>{p.title}</p>
                  <p style={{ margin: "3px 0 0", fontSize: 11.5, color: C.mute }}>{p.sub}</p>
                </div>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: C.bg2,
                  border: `1px solid ${C.line}`, display: "flex", alignItems: "center",
                  justifyContent: "center", flexShrink: 0, color: C.ink2 }}>
                  <I.Arrow size={14} sw={2} color={C.ink2}/>
                </div>
              </div>
            </Card>
          </a>
        ))}
      </div>

      {/* ── 3. KPIs FINANCIEROS ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14, marginBottom: 14 }}>
        <KpiCard label="Servicios · mes"  value={reservas.length} delta={12} intent="neutral"
          spark={[18,22,19,25,28,30,27,32,34,36]} icon={I.CalRange} onClick={() => router.push("/reservas")}/>
        <KpiCard label="Facturado · mes"  value={fmtSoles(totalFacturado)} delta={9.4} intent="neutral"
          spark={[12,14,13,15,17,19,21,20,22,24]} icon={I.Receipt} onClick={() => router.push("/facturacion")}/>
        <KpiCard label="Margen · mes"     value={fmtSoles(totalMargen)} delta={6.1} intent="positive"
          spark={[5,6,5.5,7,8,7.5,8.2,9,9.8]} sparkColor={C.ok} icon={I.TrendUp}/>
        <KpiCard label="Gastos · mes"     value={fmtSoles(totalGastosGen)} delta={3.2} deltaInvert intent="negative"
          spark={[8,9,9.5,10,11,10.5,11.5,12,13,14]} sparkColor={C.danger} icon={I.TrendDown} onClick={() => router.push("/gastos")}/>
        <KpiCard label="Cumplimiento SLA" value={`${margenPct}%`} delta={1.2} intent="neutral"
          spark={[94,95,96,95,97,96,98,98,99]} icon={I.FileCheck}/>
      </div>

      {/* ── 4. KPIs OPERATIVOS ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14, marginBottom: 18 }}>
        <KpiCard label="Flota activa"         value={verdes} suffix={`/ ${vehiculos.length}`} intent="neutral" icon={I.Bus} onClick={() => router.push("/vehiculos")}/>
        <KpiCard label="Conductores activos"  value={condDisp} suffix={`/ ${conductores.length}`} intent="neutral" icon={I.UserCheck} onClick={() => router.push("/conductores")}/>
        <KpiCard label="Clientes activos"     value={confirmadas.length + finalizadas.length} delta={4} intent="neutral" icon={I.Users}/>
        <KpiCard label="Reservas pendientes"  value={pendientes.length} delta={pendientes.length > 0 ? -(pendientes.length) : 0} intent="neutral" icon={I.FileText} onClick={() => router.push("/reservas")}/>
        <KpiCard label="Servicios hoy"        value={resHoy.length} intent="neutral" icon={I.Calendar}/>
      </div>

      {/* ── 5. ESTADO POR ÁREA ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 14, marginBottom: 18 }}>
        <AreaTile icon={I.FileCheck} label="Docs. Vehiculares"
          value={docsOblVenc > 0 ? `${docsOblVenc} venc.` : "Al día"}
          sub={`${docsPorVenc} por vencer`} intent={areaIntentDoc} onClick={() => router.push("/documentos-vehiculares")}/>
        <AreaTile icon={I.Circle} label="Neumáticos"
          value={neuCrit > 0 ? `${neuCrit} críticos` : "OK"}
          sub={`${neuPorVenc} por vencer`} intent={areaIntentNeu} onClick={() => router.push("/neumaticos")}/>
        <AreaTile icon={I.Fuel} label="Combustible"
          value={fmtSoles(gastoCombustible)}
          sub="Carga del mes" intent="neutral" onClick={() => router.push("/combustible")}/>
        <AreaTile icon={I.Shield} label="Seguros"
          value={segOblVenc > 0 ? `${segOblVenc} venc.` : "Al día"}
          sub={segPorVenc > 0 ? `${segPorVenc} por vencer` : "Pólizas vigentes"} intent={areaIntentSeg} onClick={() => router.push("/seguros")}/>
        <AreaTile icon={I.Hand} label="Tercerizadas"
          value={`${empresasTer.length} emp.`}
          sub={empConRiesgo > 0 ? `${empConRiesgo} en riesgo` : "Flota externa activa"}
          intent={empConRiesgo > 0 ? "danger" : "neutral"} onClick={() => router.push("/tercerizadas")}/>
        <AreaTile icon={I.Wrench} label="Mantenimiento"
          value={mantPend > 0 ? `${mantPend} pend.` : "Al día"}
          sub={`${mantProx} en 15 días`} intent={areaIntentMant} onClick={() => router.push("/mantenimiento?tab=historial")}/>
      </div>

      {/* ── 6. EFICIENCIA + SEMÁFORO + ALERTAS ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 14 }}>

        {/* 6A Eficiencia */}
        <Card pad={18}>
          <Eyebrow>Eficiencia operativa</Eyebrow>
          <h3 style={{ margin: "6px 0 16px", fontFamily: "var(--font-sans)", fontWeight: 800, fontSize: 16, color: C.ink, letterSpacing: -0.3 }}>
            Cumplimiento del día
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 16 }}>
            <Ring value={pctAsig} label="Asignación" color={C.navy}/>
            <Ring value={pctComp} label="Completados" color={C.mute2}/>
            <Ring value={dispMecan} label="Disponib."  color={C.ok}/>
          </div>
          <div style={{ paddingTop: 14, borderTop: `1px solid ${C.line2}` }}>
            <Eyebrow style={{ marginBottom: 10 }}>Reservas por estado</Eyebrow>
            {[
              { label:"Pendientes",  value:pendientes.length,  color:C.line },
              { label:"Confirmadas", value:confirmadas.length, color:C.ok },
              { label:"Finalizadas", value:finalizadas.length, color:C.navy },
              { label:"Canceladas",  value:canceladas.length,  color:C.mute },
            ].map(r => (
              <div key={r.label} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                <span style={{ width:80, fontSize:11.5, color:C.ink2, fontWeight:600, flexShrink:0 }}>{r.label}</span>
                <div style={{ flex:1, height:5, background:C.line2, borderRadius:999, overflow:"hidden" }}>
                  <div style={{ width:`${(r.value/maxEstado)*100}%`, height:"100%", background:r.color, borderRadius:999 }}/>
                </div>
                <span style={{ fontFamily:"var(--font-mono)", fontSize:12, fontWeight:700, color:C.ink, width:16, textAlign:"right" }}>{r.value}</span>
              </div>
            ))}
            <div style={{ display:"flex", gap:14, marginTop:12, paddingTop:12, borderTop:`1px solid ${C.line2}` }}>
              <span style={{ fontSize:11, color:C.mute, fontWeight:600 }}>
                <span style={{ color:C.ink, fontWeight:700 }}>Tercerizado:</span> {tercerizadas.length}
              </span>
              <span style={{ fontSize:11, color:C.mute, fontWeight:600 }}>
                <span style={{ color:C.ink, fontWeight:700 }}>Hoy:</span> {resHoy.length}
              </span>
            </div>
          </div>
        </Card>

        {/* 6B Semáforo */}
        <Card pad={18}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
            <div>
              <Eyebrow>Semáforo de flota</Eyebrow>
              <h3 style={{ margin:"6px 0 0", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:16, color:C.ink, letterSpacing:-0.3 }}>
                Estado mecánico
              </h3>
            </div>
            <button onClick={() => router.push("/vehiculos")}
              style={{ fontSize:11, fontWeight:700, color:C.blue, background:"none", border:"none",
                cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, fontFamily:"var(--font-sans)" }}>
              Ver flota <I.Arrow size={11} sw={2} color={C.blue}/>
            </button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:16 }}>
            {[
              { value:verdes,    label:"Operativo", color:C.ok,     bg:C.okTint },
              { value:amarillos, label:"Atención",  color:C.warn,   bg:C.warnTint },
              { value:rojos,     label:"Crítico",   color:C.danger, bg:C.dangerTint },
            ].map(s => (
              <div key={s.label} style={{ background:s.bg, borderRadius:11, padding:"14px 10px",
                textAlign:"center", border:`1px solid ${s.color}22` }}>
                <Metric size={26} color={s.color}>{s.value}</Metric>
                <p style={{ margin:"6px 0 0", fontSize:9.5, fontWeight:800, color:s.color,
                  letterSpacing:1.1, textTransform:"uppercase" }}>{s.label}</p>
              </div>
            ))}
          </div>
          <div style={{ paddingTop:14, borderTop:`1px solid ${C.line2}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
              <span style={{ fontSize:11.5, fontWeight:700, color:C.ink2 }}>Disponibilidad mecánica</span>
              <Metric size={15} color={dispMecan>=80?C.ok:dispMecan>=60?C.warn:C.danger}>{dispMecan}%</Metric>
            </div>
            <div style={{ height:7, background:C.line2, borderRadius:999, overflow:"hidden" }}>
              <div style={{ width:`${dispMecan}%`, height:"100%", borderRadius:999,
                background: dispMecan>=80?C.ok:dispMecan>=60?C.warn:C.danger }}/>
            </div>
            <p style={{ margin:"6px 0 0", fontFamily:"var(--font-mono)", fontSize:10.5, color:C.mute, fontWeight:600 }}>
              Meta: 95% · CPK: {cpkFlota > 0 ? `S/ ${cpkFlota.toFixed(3)}` : "—"}
            </p>
            <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.line2}` }}>
              {datosFlota.slice(0,3).map(d => (
                <div key={d.vehiculo.id} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span style={{ width:8, height:8, borderRadius:999, flexShrink:0,
                    background: d.semaforo.estado==="verde"?C.ok:d.semaforo.estado==="amarillo"?C.warn:C.danger }}/>
                  <span style={{ fontFamily:"var(--font-mono)", fontSize:12, fontWeight:700, color:C.ink }}>{d.vehiculo.placa}</span>
                  <span style={{ fontSize:11, color:C.mute, marginLeft:"auto", fontWeight:600 }}>{d.semaforo.razon}</span>
                </div>
              ))}
              {vehiculos.length===0 && <p style={{ fontSize:13, color:C.mute, textAlign:"center" }}>Sin vehículos</p>}
            </div>
          </div>
        </Card>

        {/* 6C Centro de alertas */}
        <Card pad={0} style={{ overflow:"hidden" }}>
          <div style={{ padding:"18px 18px 14px", display:"flex", justifyContent:"space-between",
            alignItems:"center", borderBottom:`1px solid ${C.line2}` }}>
            <div>
              <Eyebrow>Alertas críticas</Eyebrow>
              <h3 style={{ margin:"6px 0 0", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:16, color:C.ink, letterSpacing:-0.3 }}>
                Requieren acción
              </h3>
            </div>
            <span style={{ width:26, height:26, borderRadius:999, background:C.dangerTint, color:C.danger,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:"var(--font-mono)", fontSize:12, fontWeight:700 }}>
              {alertasCrit.length + alertasAten.length}
            </span>
          </div>
          <div style={{ overflowY:"auto", maxHeight:340 }}>
            {alertasCrit.map((a,i) => (
              <div key={`c${i}`} style={{ borderBottom:`1px solid ${C.line2}` }}>
                <AlertaItem tipo={a.tipo} texto={a.texto} href={a.href} router={router}/>
              </div>
            ))}
            {alertasAten.map((a,i) => (
              <div key={`a${i}`} style={{ borderBottom:`1px solid ${C.line2}` }}>
                <AlertaItem tipo={a.tipo} texto={a.texto} href={a.href} router={router}/>
              </div>
            ))}
            {alertasInfo.map((a,i) => (
              <div key={`i${i}`} style={{ borderBottom:`1px solid ${C.line2}` }}>
                <AlertaItem tipo={a.tipo} texto={a.texto} href={a.href} router={router}/>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ── 7. TERCERIZADAS + DOCS + COSTOS ── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14, marginBottom:14 }}>

        {/* 7A Empresas tercerizadas */}
        <Card pad={0} style={{ overflow:"hidden" }}>
          <div style={{ padding:"16px 18px", display:"flex", justifyContent:"space-between",
            alignItems:"center", borderBottom:`1px solid ${C.line2}` }}>
            <div>
              <Eyebrow>Flota externa</Eyebrow>
              <h3 style={{ margin:"6px 0 0", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:16, color:C.ink, letterSpacing:-0.3 }}>
                Empresas tercerizadas
              </h3>
            </div>
            <button onClick={() => router.push("/tercerizadas")}
              style={{ fontSize:11, fontWeight:700, color:C.blue, background:"none", border:"none",
                cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, fontFamily:"var(--font-sans)" }}>
              Gestionar <I.Arrow size={11} sw={2} color={C.blue}/>
            </button>
          </div>
          <div style={{ padding:"14px 18px" }}>
            {empresasTer.length === 0
              ? <p style={{ fontSize:13, color:C.mute, textAlign:"center", padding:"12px 0" }}>Sin empresas registradas</p>
              : empresasTer.slice(0, 5).map(e => {
                  const docs = docsTercero.filter(d => d.empresa_id === e.id);
                  const venc = docs.some(d => DOCS_OBL.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "vencido");
                  const porV = !venc && docs.some(d => DOCS_OBL.includes(d.tipo) && estadoFecha(d.fecha_vencimiento) === "por_vencer");
                  const code = e.razon_social.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
                  return (
                    <div key={e.id} onClick={() => router.push("/tercerizadas")} style={{
                      display:"flex", alignItems:"center", gap:12, padding:"10px 12px",
                      borderRadius:10, border:`1px solid ${venc?C.danger+"44":porV?C.warn+"44":C.line2}`,
                      background:"#fff", marginBottom:8, cursor:"pointer" }}>
                      <div style={{ width:36, height:36, borderRadius:9, background:C.blueTint,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontFamily:"var(--font-mono)", fontSize:11, fontWeight:800, color:C.navy, flexShrink:0 }}>
                        {code}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ margin:0, fontSize:12.5, fontWeight:700, color:C.ink,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{e.razon_social}</p>
                        <p style={{ margin:"2px 0 0", fontFamily:"var(--font-mono)", fontSize:10.5, color:C.mute2 }}>
                          {e.estado}
                        </p>
                      </div>
                      <Tag bg={venc?C.dangerTint:porV?C.warnTint:C.okTint}
                           color={venc?C.danger:porV?C.warn:C.ok} size="xs">
                        {venc ? "Doc. vencido" : porV ? "Por vencer" : "OK"}
                      </Tag>
                    </div>
                  );
                })
            }
          </div>
        </Card>

        {/* 7B Docs por vencer */}
        <Card pad={0} style={{ overflow:"hidden" }}>
          <div style={{ padding:"16px 18px", display:"flex", justifyContent:"space-between",
            alignItems:"center", borderBottom:`1px solid ${C.line2}` }}>
            <div>
              <Eyebrow>Control · vencimientos</Eyebrow>
              <h3 style={{ margin:"6px 0 0", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:16, color:C.ink, letterSpacing:-0.3 }}>
                Documentos por vencer
              </h3>
            </div>
            <button onClick={() => router.push("/documentos-vehiculares")}
              style={{ fontSize:11, fontWeight:700, color:C.blue, background:"none", border:"none",
                cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, fontFamily:"var(--font-sans)" }}>
              Ver todos <I.Arrow size={11} sw={2} color={C.blue}/>
            </button>
          </div>
          <div>
            {proxDocs.length === 0
              ? <p style={{ fontSize:13, color:C.mute, textAlign:"center", padding:"24px 0" }}>Sin vencimientos próximos</p>
              : proxDocs.map((d, i) => {
                  const dias = diasPara(d.fecha_vencimiento) ?? 0;
                  const venc = dias < 0;
                  const veh  = vehiculos.find(v => v.id === d.vehiculo_id);
                  return (
                    <div key={d.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 18px",
                      borderBottom: i < proxDocs.length-1 ? `1px solid ${C.line2}` : "none" }}>
                      <div style={{ width:38, height:38, borderRadius:9, flexShrink:0,
                        background: venc ? C.dangerTint : C.blueTint,
                        color: venc ? C.danger : C.navy,
                        display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <I.FileCheck size={18} sw={2} color={venc ? C.danger : C.navy}/>
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <span style={{ fontSize:13, fontWeight:700, color:C.ink }}>{d.tipo}</span>
                          {veh && <><span style={{ fontSize:11, color:C.mute2 }}>·</span>
                          <span style={{ fontFamily:"var(--font-mono)", fontSize:11.5, color:C.mute }}>{veh.placa}</span></>}
                        </div>
                        <p style={{ margin:"3px 0 0", fontSize:11.5, color:C.mute }}>Vence {fmtFecha(d.fecha_vencimiento)}</p>
                      </div>
                      {venc
                        ? <Tag bg={C.dangerTint} color={C.danger} size="xs">Vencido · {Math.abs(dias)}d</Tag>
                        : dias <= 15
                          ? <Tag bg={C.warnTint} color={C.warn} size="xs">En {dias} días</Tag>
                          : <Tag bg={C.bg2} color={C.ink2} size="xs">En {dias} días</Tag>
                      }
                    </div>
                  );
                })
            }
          </div>
        </Card>

        {/* 7C Desglose costos */}
        <Card pad={18}>
          <Eyebrow>Finanzas del día</Eyebrow>
          <h3 style={{ margin:"6px 0 16px", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:16, color:C.ink, letterSpacing:-0.3 }}>
            Desglose de costos
          </h3>
          {[
            { label:"Combustible",      value:gastoCombustible, dot:C.danger, href:"/combustible" },
            { label:"Mantenimiento",    value:gastoManten,      dot:C.warn,   href:"/mantenimiento?tab=historial" },
            { label:"Gastos generales", value:totalGastosGen,   dot:C.navy,   href:"/gastos" },
          ].map((c, i, arr) => (
            <div key={c.label} onClick={() => router.push(c.href)}
              style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 0",
                borderBottom: i < arr.length-1 ? `1px solid ${C.line2}` : "none", cursor:"pointer" }}>
              <span style={{ width:8, height:8, borderRadius:999, background:c.dot, flexShrink:0 }}/>
              <span style={{ flex:1, fontSize:12.5, fontWeight:600, color:C.ink2 }}>{c.label}</span>
              <span style={{ fontFamily:"var(--font-mono)", fontSize:13, fontWeight:700, color:C.ink }}>{fmtSoles(c.value)}</span>
            </div>
          ))}
          <div style={{ marginTop:14, padding:"12px 14px", borderRadius:10, background:C.bg2, border:`1px solid ${C.line2}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
              <span style={{ fontSize:11.5, fontWeight:700, color:C.ink2 }}>Margen total</span>
              <Metric size={18}>{fmtSoles(totalMargen)}</Metric>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginTop:8 }}>
              <span style={{ fontSize:11.5, fontWeight:700, color:C.ink2 }}>CPK flota <span style={{ fontWeight:500, color:C.mute2 }}>(S/km)</span></span>
              <Metric size={16}>{cpkFlota > 0 ? `S/ ${cpkFlota.toFixed(3)}` : "—"}</Metric>
            </div>
          </div>
          <div style={{ marginTop:12, padding:"14px", borderRadius:10,
            background: utilidad>=0 ? C.okTint : C.dangerTint,
            border: `1px solid ${utilidad>=0 ? C.ok : C.danger}33`,
            display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:12, fontWeight:800, color:utilidad>=0?C.ok:C.danger }}>Utilidad estimada</span>
            <Metric size={20} color={utilidad>=0?C.ok:C.danger}>{fmtSoles(utilidad)}</Metric>
          </div>
          {cpkNeuProm !== null && (
            <div style={{ marginTop:10, display:"flex", justifyContent:"space-between", fontSize:11.5, color:C.mute }}>
              <span style={{ fontWeight:600 }}>CPK neumáticos</span>
              <span style={{ fontFamily:"var(--font-mono)", fontWeight:700, color:cpkNeuProm>3?C.danger:C.ok }}>
                S/ {cpkNeuProm.toFixed(3)}
              </span>
            </div>
          )}
        </Card>
      </div>

      {/* ── 8. FINANCE CHART + FLEET DONUT ── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(12,1fr)", gap:14, marginBottom:14 }}>
        <FinanceChart totalVentas={totalVentas} totalGastos={totalGastosGen} totalMargen={totalMargen}/>
        <FleetDonut vehiculos={vehiculos}/>
      </div>

      {/* ── 9. SERVICIOS DE HOY ── */}
      {serviciosHoy.length > 0 && (
        <Card pad={0} style={{ overflow:"hidden", marginBottom:14 }}>
          <div style={{ padding:"18px 20px", display:"flex", justifyContent:"space-between",
            alignItems:"center", borderBottom:`1px solid ${C.line2}` }}>
            <div>
              <Eyebrow>Operaciones · tiempo real</Eyebrow>
              <h3 style={{ margin:"6px 0 0", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:17, color:C.ink, letterSpacing:-0.3 }}>
                Servicios en curso · <span style={{ color:C.mute, fontWeight:600 }}>{serviciosHoy.length}</span>
              </h3>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => router.push("/monitoreo")}
                style={{ padding:"7px 12px", borderRadius:9, background:C.surface,
                  border:`1px solid ${C.line}`, cursor:"pointer", display:"inline-flex",
                  alignItems:"center", gap:6, fontSize:12, fontWeight:700, color:C.ink,
                  fontFamily:"var(--font-sans)" }}>
                <I.Arrow size={12} sw={2} color={C.ink}/> Ver mapa
              </button>
            </div>
          </div>
          {/* Tabla header */}
          <div style={{ display:"flex", padding:"10px 20px", background:C.bg2,
            borderBottom:`1px solid ${C.line2}` }}>
            {[["Servicio",1],["Cliente",1.6],["Ruta",1.8],["Conductor / Unidad",1.5],["Hora",0.7],["Estado",1]].map(([h,f]) => (
              <span key={h as string} style={{ flex: f as number, fontSize:10, fontWeight:800,
                color:C.mute, letterSpacing:1.2, textTransform:"uppercase" }}>{h}</span>
            ))}
          </div>
          {serviciosHoy.map((s, i) => {
            const est = estadoBadge[s.estado] || { bg:C.bg2, c:C.ink2, dot:C.mute };
            return (
              <div key={s.id} onClick={() => router.push("/reservas")}
                style={{ display:"flex", alignItems:"center", padding:"14px 20px",
                  borderBottom: i < serviciosHoy.length-1 ? `1px solid ${C.line2}` : "none",
                  cursor:"pointer" }}>
                <div style={{ flex:1 }}>
                  <p style={{ margin:0, fontFamily:"var(--font-mono)", fontSize:12, fontWeight:700, color:C.ink }}>
                    #{s.id}
                  </p>
                </div>
                <div style={{ flex:1.6, minWidth:0, paddingRight:8 }}>
                  <p style={{ margin:0, fontSize:12.5, fontWeight:700, color:C.ink,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.cliente}</p>
                </div>
                <div style={{ flex:1.8, minWidth:0, paddingRight:8 }}>
                  <p style={{ margin:0, fontSize:12, color:C.ink2,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {s.origen} → {s.destino}
                  </p>
                </div>
                <div style={{ flex:1.5, minWidth:0 }}>
                  <p style={{ margin:0, fontSize:12, fontWeight:600, color:C.ink2 }}>
                    {s.conductor?.split(" ").slice(0,2).join(" ") || <span style={{ color:C.mute2 }}>Sin asignar</span>}
                  </p>
                  {s.placa && <p style={{ margin:"2px 0 0", fontFamily:"var(--font-mono)", fontSize:10.5, color:C.mute2 }}>{s.placa}</p>}
                </div>
                <div style={{ flex:0.7 }}>
                  <p style={{ margin:0, fontFamily:"var(--font-mono)", fontSize:12, fontWeight:700, color:C.ink }}>
                    {s.hora_servicio?.slice(0,5) || "—"}
                  </p>
                </div>
                <div style={{ flex:1 }}>
                  <Tag bg={est.bg} color={est.c} dot={est.dot} size="xs">{s.estado}</Tag>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* ── 10. MANTENIMIENTOS PROGRAMADOS ── */}
      {mantProximos.length > 0 && (
        <Card pad={0} style={{ overflow:"hidden", marginBottom:14 }}>
          <div style={{ padding:"18px 20px", display:"flex", justifyContent:"space-between",
            alignItems:"center", borderBottom:`1px solid ${C.line2}` }}>
            <div>
              <Eyebrow>Flota · próximos 7 días</Eyebrow>
              <h3 style={{ margin:"6px 0 0", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:17, color:C.ink, letterSpacing:-0.3 }}>
                Mantenimientos programados
              </h3>
            </div>
            <button onClick={() => router.push("/mantenimiento?tab=historial")}
              style={{ fontSize:11, fontWeight:700, color:C.blue, background:"none", border:"none",
                cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, fontFamily:"var(--font-sans)" }}>
              Ver todos <I.Arrow size={11} sw={2} color={C.blue}/>
            </button>
          </div>
          {mantProximos.map((m, i) => {
            const dias   = diasPara(m.proxima_fecha) ?? 0;
            const veh    = vehiculos.find(v => v.id === m.vehiculo_id);
            const urgent = dias <= 1;
            return (
              <div key={m.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 20px",
                borderBottom: i < mantProximos.length-1 ? `1px solid ${C.line2}` : "none" }}>
                <div style={{ width:38, height:38, borderRadius:9, flexShrink:0,
                  background:C.blueTint, color:C.navy,
                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <I.Wrench size={18} sw={2} color={C.navy}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {veh && <span style={{ fontFamily:"var(--font-mono)", fontSize:12, fontWeight:700, color:C.ink }}>{veh.placa}</span>}
                    {m.tipo && <><span style={{ fontSize:11, color:C.mute2 }}>·</span><span style={{ fontSize:11.5, color:C.mute }}>{m.tipo}</span></>}
                  </div>
                  {veh && <p style={{ margin:"3px 0 0", fontFamily:"var(--font-mono)", fontSize:10.5, color:C.mute2 }}>
                    {Number(veh.kilometraje_actual||0).toLocaleString()} km
                  </p>}
                </div>
                <Tag bg={urgent?C.warnTint:C.bg2} color={urgent?C.warn:C.ink2}>
                  {dias < 0 ? "Vencido" : dias === 0 ? "Hoy" : dias === 1 ? "Mañana" : `En ${dias}d`}
                </Tag>
              </div>
            );
          })}
        </Card>
      )}

      {/* ── 11. ÚLTIMAS RESERVAS ── */}
      <Card pad={0} style={{ overflow:"hidden" }}>
        <div style={{ padding:"16px 20px", display:"flex", justifyContent:"space-between",
          alignItems:"center", borderBottom:`1px solid ${C.line2}` }}>
          <div>
            <Eyebrow>Comercial · histórico reciente</Eyebrow>
            <h3 style={{ margin:"6px 0 0", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:16, color:C.ink, letterSpacing:-0.3 }}>
              Últimas 5 reservas
            </h3>
          </div>
          <button onClick={() => router.push("/reservas")}
            style={{ fontSize:11, fontWeight:700, color:C.blue, background:"none", border:"none",
              cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, fontFamily:"var(--font-sans)" }}>
            Ver todas <I.Arrow size={11} sw={2} color={C.blue}/>
          </button>
        </div>
        {/* Header cols */}
        <div style={{ display:"flex", padding:"10px 20px", background:C.bg2, borderBottom:`1px solid ${C.line2}` }}>
          {[["ID",0.5],["Ruta",4],["Fecha",1],["Asignación",1],["Estado",1],["Precio",1],["Margen",1]].map(([l,f]) => (
            <span key={l as string} style={{ flex: f as number, fontSize:10, fontWeight:800,
              color:C.mute, letterSpacing:1.2, textTransform:"uppercase" }}>{l}</span>
          ))}
        </div>
        {reservas.slice(0, 5).map((r, i) => {
          const estados: Record<string,{bg:string;c:string;dot:string}> = {
            pendiente:  { bg:"#fef9c3", c:"#854d0e", dot:"#eab308" },
            programada: { bg:"#e0f2fe", c:"#0369a1", dot:"#0284c7" },
            confirmada: { bg:C.okTint,  c:C.ok,      dot:C.ok },
            en_curso:   { bg:"#dbeafe", c:"#1d4ed8",  dot:"#2563eb" },
            finalizada: { bg:"#ede9fe", c:"#6d28d9",  dot:"#7c3aed" },
            cancelada:  { bg:C.dangerTint, c:C.danger, dot:C.danger },
          };
          const est    = estados[r.estado] || { bg:C.bg2, c:C.ink2, dot:C.mute };
          const esTer  = r.tipo === "tercerizada";
          const margen = Number(r.margen || 0);
          return (
            <div key={r.id} onClick={() => router.push("/reservas")}
              style={{ display:"flex", alignItems:"center", padding:"13px 20px",
                borderBottom: i < 4 ? `1px solid ${C.line2}` : "none", cursor:"pointer" }}>
              <span style={{ flex:0.5, fontFamily:"var(--font-mono)", fontSize:12, fontWeight:700, color:C.ink }}>#{r.id}</span>
              <span style={{ flex:4, fontSize:12, color:C.ink2,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", paddingRight:14 }}>
                {r.origen} → {r.destino}
              </span>
              <span style={{ flex:1, fontFamily:"var(--font-mono)", fontSize:11.5, color:C.mute }}>{fmtFecha(r.fecha_servicio)}</span>
              <span style={{ flex:1 }}>
                <Tag bg={esTer?C.warnTint:C.blueTint} color={esTer?C.warn:C.navy} size="xs">
                  {esTer ? "Terc." : "Prop."}
                </Tag>
              </span>
              <span style={{ flex:1 }}>
                <Tag bg={est.bg} color={est.c} dot={est.dot} size="xs">{r.estado}</Tag>
              </span>
              <span style={{ flex:1, fontFamily:"var(--font-mono)", fontSize:12.5, fontWeight:700, color:C.ink }}>
                {fmtSoles(Number(r.precio_cliente||0))}
              </span>
              <span style={{ flex:1, fontFamily:"var(--font-mono)", fontSize:12.5, fontWeight:700,
                color: margen >= 0 ? C.ok : C.danger }}>
                {fmtSoles(margen)}
              </span>
            </div>
          );
        })}
        {reservas.length === 0 && (
          <div style={{ padding:"40px 20px", textAlign:"center" }}>
            <p style={{ fontSize:13, color:C.mute }}>No hay reservas</p>
          </div>
        )}
        <div style={{ padding:"10px 20px", background:C.bg2, fontSize:10.5, color:C.mute2, fontWeight:600 }}>
          Mostrando {Math.min(5, reservas.length)} de {reservas.length} reservas · AFA ERP · Dashboard
        </div>
      </Card>

      {/* ── 12. CENTRO DE AYUDA ── */}
      <Card>
        <Eyebrow>Capacitación</Eyebrow>
        <h3 style={{ margin:"6px 0 14px", fontFamily:"var(--font-sans)", fontWeight:800, fontSize:16, color:C.ink, letterSpacing:-0.3 }}>
          Centro de ayuda
        </h3>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))", gap:12 }}>
          {[
            { href:"/manuales/conductor",     label:"Manual App Conductor",   desc:"Conectarse, iniciar viaje, escanear QR" },
            { href:"/manuales/pasajero",      label:"Manual App Pasajero",    desc:"Ver el bus en vivo, paradero, pase" },
            { href:"/manuales/portal-cliente",label:"Manual Portal Cliente",  desc:"Dashboard, GPS en vivo, facturación" },
          ].map((m) => (
            <a key={m.href} href={m.href} target="_blank" rel="noopener noreferrer"
              style={{
                display:"flex", alignItems:"center", gap:12, padding:"14px 16px",
                borderRadius:11, border:`1px solid ${C.line2}`, textDecoration:"none",
              }}>
              <div style={{ width:36, height:36, borderRadius:9, background:C.blueTint,
                display:"flex", alignItems:"center", justifyContent:"center", flex:"none" }}>
                <I.FileCheck size={17} sw={2} color={C.navy}/>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <p style={{ margin:0, fontSize:12.5, fontWeight:700, color:C.ink }}>{m.label}</p>
                <p style={{ margin:"2px 0 0", fontSize:11, color:C.mute, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.desc}</p>
              </div>
              <I.Arrow size={13} sw={2} color={C.mute}/>
            </a>
          ))}
        </div>
      </Card>
    </div>
  );
}
