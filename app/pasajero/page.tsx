"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { pedirPermisoUbicacion, obtenerUbicacion, observarUbicacion, geoDisponible, esAppNativa, type GeoWatch } from "@/lib/geo";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Pasajero = {
  id: number; nombre: string; dni: string | null; empresa: string | null;
  telefono: string | null; qr_code: string | null; foto_url: string | null;
};
type Parada = {
  id: number; reserva_id: number; orden: number; nombre: string;
  direccion: string | null; lat: number | null; lng: number | null;
  hora_estimada: string | null; estado: string;
};
type Reserva = {
  id: number; origen: string; destino: string;
  fecha_servicio: string | null; hora_servicio: string | null;
  vehiculo_id: number | null;
};
type UbicacionBus = {
  vehiculo_id: number; lat: number; lng: number;
  velocidad: number; estado: string; timestamp: string;
};
type Vehiculo  = { id: number; placa: string; categoria: string | null };
type Conductor = { id: number; nombre: string; telefono: string | null };
type Tab       = "ruta" | "qr" | "perfil";
type EstadoBus = "no_iniciado" | "en_camino" | "retrasado" | "finalizado" | "sin_señal";
type GpsPermiso = "unknown" | "granted" | "denied" | "unavailable";

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getFechaLocal(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
}
const SK = "afa_pasajero_v2";
function saveSession(p: Pasajero) { localStorage.setItem(SK, JSON.stringify({ p, exp: Date.now()+86400000 })); }
function loadSession(): Pasajero | null {
  try { const r = localStorage.getItem(SK); if(!r) return null; const {p,exp}=JSON.parse(r); if(Date.now()>exp){localStorage.removeItem(SK);return null;} return p; } catch{return null;}
}
function clearSession() { localStorage.removeItem(SK); }
// Llama al endpoint con service_role del pasajero (saltea RLS — el pasajero es
// anónimo porque usa DNI+PIN, no sesión Supabase). Lanza Error con el mensaje del server.
async function paxApi(accion: string, params: Record<string, any> = {}) {
  const res = await fetch("/api/pasajero", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accion, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Error de red");
  return json;
}
function dist(lat1:number,lng1:number,lat2:number,lng2:number): number {
  const R=6371000,φ1=lat1*Math.PI/180,φ2=lat2*Math.PI/180,Δφ=(lat2-lat1)*Math.PI/180,Δλ=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(Δφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function calcETA(d:number,v:number): number { return Math.ceil((d/1000)/(v>5?v:25)*60); }
function fmtETA(m:number): string { if(m<=0) return "¡Llegando!"; if(m<60) return `${m} min`; return `${Math.floor(m/60)}h ${m%60}m`; }
function fmtDist(m:number): string { return m>=1000?`${(m/1000).toFixed(1)} km`:`${Math.round(m)} m`; }
function ini(n:string): string { return n.split(" ").slice(0,2).map(w=>w[0]).join("").toUpperCase(); }

// Detectar si es iOS
function esIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
}

// ─── SVG ICONS ────────────────────────────────────────────────────────────────

function IC({ ch, sz = 20, c = "currentColor", sw = 1.75, fill = "none" }: { ch: React.ReactNode; sz?: number; c?: string; sw?: number; fill?: string }) {
  return (
    <svg width={sz} height={sz} viewBox="0 0 24 24" fill={fill} stroke={c}
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
      {ch}
    </svg>
  );
}
function IconBus({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h20"/><path d="M4 19h2a1 1 0 0 0 1-1v-2h10v2a1 1 0 0 0 1 1h2"/><path d="M4 18V8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10"/><circle cx="8" cy="16" r="1" fill={c} stroke="none"/><circle cx="16" cy="16" r="1" fill={c} stroke="none"/></>}/>;
}
function IconMap({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14"/><path d="M15 6v14"/></>}/>;
}
function IconPin({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></>}/>;
}
function IconClock({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>}/>;
}
function IconQR({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v3"/><path d="M14 20h3"/><path d="M20 20v1"/></>}/>;
}
function IconUser({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></>}/>;
}
function IconPhone({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<path d="M5 4h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>}/>;
}
function IconShare({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></>}/>;
}
function IconArrowRight({ sz = 18, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></>}/>;
}
function IconCheck({ sz = 20, c = "currentColor", sw = 1.75 }: { sz?: number; c?: string; sw?: number }) {
  return <IC sz={sz} c={c} sw={sw} ch={<path d="M5 12l5 5L20 6"/>}/>;
}
function IconClose({ sz = 20, c = "currentColor", sw = 1.75 }: { sz?: number; c?: string; sw?: number }) {
  return <IC sz={sz} c={c} sw={sw} ch={<><path d="M6 6l12 12"/><path d="M18 6L6 18"/></>}/>;
}
function IconBell({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2v1h16v-1l-2-2z"/><path d="M10 20a2 2 0 0 0 4 0"/></>}/>;
}
function IconRoute({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3"/></>}/>;
}
function IconNav({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<path d="M3 11l18-8-8 18-2-8-8-2z"/>}/>;
}
function IconCrosshair({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/></>}/>;
}
function IconMail({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 7 9-7"/></>}/>;
}
function IconWhatsapp({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M3 21l1.5-4.5A8 8 0 1 1 8 20l-5 1z"/><path d="M8 11c.5 2 2 3.5 4 4l1-1 2 1v2c-3 0-7-2-8-7l2-1 1 2-2 0z" fill={c} stroke="none"/></>}/>;
}
function IconLogout({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M14 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h11"/></>}/>;
}
function IconWifiOff({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M2 12c2-3 5.5-5 10-5s8 2 10 5"/><path d="M5 16c1.5-2 4-3 7-3s5.5 1 7 3"/><circle cx="12" cy="20" r="1" fill={c} stroke="none"/><line x1="3" y1="3" x2="21" y2="21" stroke={c} strokeWidth="2"/></>}/>;
}
function IconCamera({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></>}/>;
}
function IconChevronRight({ sz = 16, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<path d="M9 6l6 6-6 6"/>}/>;
}
function IconBuilding({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><rect x="5" y="4" width="14" height="17" rx="1"/><path d="M9 9h2"/><path d="M13 9h2"/><path d="M9 13h2"/><path d="M13 13h2"/><path d="M10 21v-3h4v3"/></>}/>;
}
function IconMessageCircle({ sz = 20, c = "currentColor" }: { sz?: number; c?: string }) {
  return <IC sz={sz} c={c} ch={<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>}/>;
}
const CondorMark = ({ size = 24, color = "currentColor" }: { size?: number; color?: string }) => (
  <svg width={size} height={size * 0.5} viewBox="0 0 48 24" fill={color} style={{ display: "block" }}>
    <path d="M2 14c4-2 8-2 12 0 2-4 6-6 10-6s8 2 10 6c4-2 8-2 12 0-3-1-6-1-9 1-2 1-4 1-6-1-2-3-5-4-7-4s-5 1-7 4c-2 2-4 2-6 1-3-2-6-2-9-1z"/>
    <circle cx="24" cy="11" r="1.2"/>
  </svg>
);
const StatusDot = ({ color, size = 8, pulse = true }: { color: string; size?: number; pulse?: boolean }) => (
  <span style={{ width: size, height: size, borderRadius: size, background: color, display: "inline-block", position: "relative", flexShrink: 0 }}>
    {pulse && <span style={{ position: "absolute", inset: 0, borderRadius: size, background: color, animation: "statusPulse 1.6s ease-out infinite" }} />}
  </span>
);
const Eyebrow = ({ children, color = "#6B7280" }: { children: React.ReactNode; color?: string }) => (
  <p style={{ fontFamily: "var(--f)", fontSize: 10, fontWeight: 700, color, letterSpacing: 1.2, textTransform: "uppercase", margin: 0 }}>{children}</p>
);
const Chip = ({ children, color = "#0E1320", bg = "#F4F2EA", mono = false }: { children: React.ReactNode; color?: string; bg?: string; mono?: boolean }) => (
  <span style={{ fontFamily: mono ? "var(--m)" : "var(--f)", fontWeight: 700, fontSize: 11, letterSpacing: mono ? 0.3 : 0.1, color, background: bg, padding: "4px 10px", borderRadius: 999, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>{children}</span>
);

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
:root{
  --navy:#0b315f; --navy-deep:#071f3d; --navy-tint:#EEF2F8; --blue:#2563eb;
  --ink:#0E1320; --ink2:#1a2233; --mute:#6B7280; --mute2:#9AA1AC;
  --line:#E7E5DD; --line2:#EFEEE6;
  --paper:#FAF8F2; --surface:#FFFFFF; --soft:#F4F2EA;
  --success:#16a34a; --success-tint:#E8F5E9;
  --warn:#B45309; --warn-tint:#FDF3D7;
  --danger:#B91C1C; --danger-tint:#FCEBEA;
  --coral:#E26B47; --coral-tint:#FCEEE6;
  --f:'Manrope',-apple-system,system-ui,sans-serif;
  --m:'JetBrains Mono','DM Mono',ui-monospace,monospace;
}
.afa-backdrop{position:fixed;inset:0;z-index:9998;background:var(--paper);}
.afa-app{position:fixed;inset:0;z-index:9999;background:var(--paper);display:flex;flex-direction:column;overflow:hidden;font-family:var(--f);}

/* ── TAB BAR ── */
.afa-nav{position:absolute;bottom:0;left:0;right:0;background:rgba(255,255,255,0.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-top:1px solid var(--line2);display:flex;z-index:20;padding-bottom:22px;padding-top:8px;}
.afa-tab{flex:1;border:none;background:none;cursor:pointer;padding:4px 10px 0;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;font-family:var(--f);}
.afa-tab-lbl{font-size:10.5px;font-weight:700;color:var(--mute2);letter-spacing:.1px;}
.afa-tab.active .afa-tab-lbl{color:var(--navy);}
.afa-tab-badge{position:absolute;top:-2px;right:-3px;width:8px;height:8px;border-radius:50%;background:var(--coral);border:1.5px solid white;}
.afa-tab-bar{position:absolute;top:0;width:22px;height:3px;background:var(--navy);border-radius:3px;}

/* ── SCROLL CONTENT ── */
.afa-scroll{flex:1;overflow-y:auto;overflow-x:hidden;padding-bottom:90px;-webkit-overflow-scrolling:touch;background:var(--paper);}

/* ── MODAL ── */
.afa-modal-overlay{position:fixed;inset:0;z-index:10000;background:rgba(11,31,58,.7);display:flex;align-items:flex-end;justify-content:center;animation:afa-fadeIn .2s ease;}
.afa-modal-sheet{background:var(--surface);border-radius:24px 24px 0 0;width:100%;max-width:520px;padding:0 0 32px;box-shadow:0 -8px 40px rgba(0,0,0,.25);}
.afa-modal-handle{width:40px;height:4px;background:var(--line);border-radius:2px;margin:14px auto 20px;}
.afa-modal-title{font-weight:800;font-size:18px;color:var(--ink);margin-bottom:8px;letter-spacing:-.3px;}
.afa-modal-desc{font-size:13px;color:var(--mute);line-height:1.6;}
.afa-modal-btns{padding:0 24px;display:flex;flex-direction:column;gap:10px;}
.afa-modal-btn-p{width:100%;padding:14px 0;border-radius:14px;border:none;background:var(--navy);color:#fff;font-size:15px;font-weight:700;font-family:var(--f);cursor:pointer;}
.afa-modal-btn-s{width:100%;padding:12px 0;border-radius:14px;border:1.5px solid var(--line);background:var(--surface);color:var(--mute);font-size:14px;font-weight:600;font-family:var(--f);cursor:pointer;}

/* ── REPORTE OPT ── */
.afa-reporte-opt{width:100%;padding:12px 16px;border-radius:12px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);text-align:left;display:flex;align-items:center;gap:10px;transition:all .15s;}
.afa-reporte-opt:hover{border-color:var(--navy);background:var(--navy-tint);}
.afa-reporte-opt.sel{border-color:var(--navy);background:var(--navy-tint);color:var(--navy);}

/* ── PARADAS SHEET ── */
.afa-para-sheet{background:var(--surface);border-radius:24px 24px 0 0;width:100%;max-width:520px;box-shadow:0 -8px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;max-height:92dvh;}
.afa-para-scroll{flex:1;overflow-y:auto;padding:8px 20px 32px;-webkit-overflow-scrolling:touch;}

/* Paradas header */
.afa-para-hdr{padding:0 20px 12px;border-bottom:1px solid var(--line2);}
.afa-para-hdr-top{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
.afa-para-hdr-title{flex:1;font-weight:800;font-size:16px;color:var(--ink);letter-spacing:-.3px;}
.afa-para-cnt-badge{font-size:11px;font-weight:700;color:var(--navy);background:var(--navy-tint);padding:3px 10px;border-radius:999px;white-space:nowrap;}
.afa-para-summary{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:var(--soft);border-radius:14px;padding:10px 12px;}
.afa-para-sum-col{display:flex;flex-direction:column;gap:2px;}
.afa-para-sum-col.mid{align-items:center;}
.afa-para-sum-col.last{align-items:flex-end;}
.afa-para-sum-lbl{font-size:9.5px;font-weight:700;color:var(--mute);letter-spacing:.8px;text-transform:uppercase;}
.afa-para-sum-val{font-size:13px;font-weight:800;color:var(--ink);letter-spacing:-.1px;}
.afa-para-sum-time{font-size:11px;font-weight:600;color:var(--navy);font-family:var(--m);}

/* Paradas timeline */
.afa-para-row{display:flex;gap:0;padding:2px 0;}
.afa-para-spine{display:flex;flex-direction:column;align-items:center;width:36px;flex-shrink:0;}
.afa-para-node{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid var(--line);}
.afa-para-node.p-done{background:var(--success);border-color:var(--success);}
.afa-para-node.p-cur{background:var(--navy);border-color:var(--navy);}
.afa-para-node.p-fut{background:var(--surface);border-color:var(--line);}
.afa-para-seg{flex:1;width:2px;min-height:18px;margin:3px 0;border-radius:2px;}
.afa-para-seg.s-done{background:var(--success);}
.afa-para-seg.s-fut{background:var(--line);}
.afa-para-content{flex:1;padding:0 0 18px 12px;min-width:0;}
.afa-para-inner{background:var(--surface);border:1px solid var(--line2);border-radius:14px;padding:10px 12px;}
.afa-para-inner.p-cur{border-color:var(--navy);background:var(--navy-tint);}
.afa-para-rhead{display:flex;align-items:flex-start;gap:8px;}
.afa-para-name{font-weight:700;font-size:13.5px;color:var(--mute);line-height:1.3;letter-spacing:-.1px;}
.afa-para-name.p-done{color:var(--mute);}
.afa-para-name.p-cur{color:var(--navy);font-weight:800;}
.afa-para-name.p-fut{color:var(--ink2);}
.afa-para-addr{font-size:11px;color:var(--mute2);margin-top:2px;}
.afa-para-tval{font-family:var(--m);font-size:13px;font-weight:700;color:var(--mute);white-space:nowrap;flex-shrink:0;}
.afa-para-tval.p-cur{color:var(--navy);}
.afa-para-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;}
.afa-para-tag-m{font-size:10.5px;font-weight:700;color:var(--navy);background:var(--navy-tint);padding:3px 8px;border-radius:999px;display:inline-flex;align-items:center;gap:4px;}
.afa-para-tag-e{font-size:10.5px;font-weight:700;color:var(--warn);background:var(--warn-tint);padding:3px 8px;border-radius:999px;display:inline-flex;align-items:center;gap:4px;}

/* ── MAP MARKERS ── */
.afa-bus-mk{width:44px;height:44px;background:var(--navy);border-radius:50%;border:3px solid white;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(11,49,95,.45);cursor:pointer;}
.afa-stop-mk{background:white;border-radius:999px;padding:5px 10px;border:1.5px solid var(--navy);display:flex;align-items:center;gap:4px;box-shadow:0 4px 14px rgba(11,49,95,.2);}
.afa-me-mk{width:16px;height:16px;background:var(--blue);border-radius:50%;border:2.5px solid white;box-shadow:0 0 0 4px rgba(37,99,235,.2),0 2px 8px rgba(0,0,0,.3);}
.afa-pulse{position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--navy);opacity:0;animation:afa-pulseRing 2s ease-out infinite;}

/* ── SPINNER ── */
.afa-spin{width:30px;height:30px;border:3px solid var(--line);border-top:3px solid var(--navy);border-radius:50%;animation:afa-spin 1s linear infinite;margin:0 auto 8px;}
.afa-foto-spin{width:22px;height:22px;border:2.5px solid rgba(255,255,255,.3);border-top:2.5px solid #fff;border-radius:50%;animation:afa-spin 0.9s linear infinite;}

/* ── LOGIN ── */
.afa-login{position:fixed;inset:0;overflow-y:auto;z-index:9999;display:flex;flex-direction:column;background:var(--paper);font-family:var(--f);}
.afa-login-body{width:100%;flex:1;display:flex;flex-direction:column;}
.afa-login-err{background:var(--danger-tint);border:1px solid #FECACA;border-radius:12px;padding:12px 16px;margin-bottom:16px;text-align:center;color:var(--danger);font-size:13px;font-weight:700;}

/* ── RESPONSIVE WRAPPERS ── */
.afa-scroll-inner{width:100%;}
.afa-bottom-sheet{position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:100%;z-index:5;background:var(--paper);border-radius:24px 24px 0 0;box-shadow:0 -10px 30px rgba(0,0,0,.08);padding-bottom:90px;max-height:64%;overflow-y:auto;}
.afa-map-hdr{position:absolute;top:0;left:50%;transform:translateX(-50%);width:100%;z-index:2;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px;pointer-events:none;}
.afa-map-hdr>*{pointer-events:auto;}

/* ── KEYFRAMES ── */
@keyframes afa-spin{to{transform:rotate(360deg)}}
@keyframes afa-fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes afa-pulseRing{0%{transform:scale(1);opacity:.6}100%{transform:scale(2.2);opacity:0}}
@keyframes statusPulse{0%{transform:scale(1);opacity:.6}100%{transform:scale(2.4);opacity:0}}
@keyframes sheetIn{from{transform:translateY(-30px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes numIn{0%{transform:translateY(20px);opacity:0}70%{transform:translateY(-3px);opacity:1}100%{transform:translateY(0);opacity:1}}

/* ── BREAKPOINTS ── */
@media(min-width:640px){
  .afa-login-body{max-width:520px;margin:0 auto;}
  .afa-scroll-inner{max-width:640px;margin:0 auto;}
  .afa-bottom-sheet{max-width:600px;}
  .afa-map-hdr{max-width:600px;}
  .afa-modal-sheet,.afa-para-sheet{max-width:560px;}
  .afa-tab{padding:6px 28px 0;}
  .afa-tab-lbl{font-size:12px;}
  .afa-nav{padding-bottom:20px;padding-top:10px;}
}
@media(min-width:960px){
  .afa-login-body{max-width:560px;}
  .afa-scroll-inner{max-width:720px;}
  .afa-bottom-sheet{max-width:680px;}
  .afa-map-hdr{max-width:680px;}
  .afa-modal-sheet,.afa-para-sheet{max-width:640px;}
  .afa-tab-lbl{font-size:13px;}
}
`;

// ─── MODAL GPS ─────────────────────────────────────────────────────────────────

function ModalActivarGPS({ onReintentar, onCerrar }: { onReintentar: () => void; onCerrar: () => void }) {
  const ios    = esIOS();
  const nativa = esAppNativa();
  let pasos: string[];
  if (nativa && ios) {
    pasos = [
      "Abre Configuración en tu iPhone",
      "Baja y toca AFA Pasajero",
      "Toca Ubicación",
      "Elige Al usar la app",
      "Vuelve aquí y toca Reintentar",
    ];
  } else if (nativa) {
    // App nativa Android: hay que dar el permiso en los ajustes de la app.
    pasos = [
      "Ve a Ajustes → Aplicaciones",
      "Busca y abre AFA Pasajero",
      "Toca Permisos → Ubicación",
      "Elige Permitir (mientras se usa la app)",
      "Vuelve aquí y toca Reintentar",
    ];
  } else if (ios) {
    pasos = [
      "Abre Configuración en tu iPhone",
      "Toca Privacidad y seguridad → Localización",
      "Asegúrate que la localización esté Activada",
      "Busca tu navegador y ponlo en Al usar la app",
      "Vuelve aquí y toca Reintentar",
    ];
  } else {
    pasos = [
      "Desliza desde arriba y toca el ícono de Ubicación para activarla",
      "O ve a Ajustes → Ubicación → activa GPS",
      "En el navegador, toca el ícono de candado en la barra de dirección",
      "Toca Permisos → Ubicación → Permitir",
      "Vuelve aquí y toca Reintentar",
    ];
  }
  return (
    <div className="afa-modal-overlay" onClick={onCerrar}>
      <div className="afa-modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="afa-modal-handle" />
        <div style={{ padding: "0 24px 20px", textAlign: "center" }}>
          <div style={{ width: 64, height: 64, background: "var(--warn-tint)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <IconPin sz={28} c="var(--warn)" />
          </div>
          <div className="afa-modal-title">Activa tu ubicación</div>
          <div className="afa-modal-desc">{ios ? "Sigue estos pasos en tu iPhone:" : "Sigue estos pasos en tu Android:"}</div>
        </div>
        <div style={{ padding: "0 24px", marginBottom: 20 }}>
          {pasos.map((txt, i) => (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 0", borderBottom: i < pasos.length - 1 ? "1px solid var(--line2)" : "none" }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--navy)", color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</div>
              <p style={{ fontSize: 13, color: "var(--mute)", lineHeight: 1.5, margin: 0, paddingTop: 4 }}>{txt}</p>
            </div>
          ))}
        </div>
        <div className="afa-modal-btns">
          <button className="afa-modal-btn-p" onClick={onReintentar}>Reintentar activar GPS</button>
          <button className="afa-modal-btn-s" onClick={onCerrar}>Continuar sin ubicación</button>
        </div>
      </div>
    </div>
  );
}

// ─── MAP DECORATIVO (fallback cuando Mapbox no carga) ───────────────────────

function MapaCiudad({ showBus = true, showStop = true }: { showBus?: boolean; showStop?: boolean }) {
  return (
    <svg viewBox="0 0 420 310" xmlns="http://www.w3.org/2000/svg"
      style={{ position:"absolute", inset:0, width:"100%", height:"100%" }}
      preserveAspectRatio="xMidYMid slice">
      <rect width="420" height="310" fill="#EAE6DF" />
      <rect x="0" y="255" width="420" height="55" fill="#C8DFF0" opacity="0.6" />
      <rect x="310" y="60" width="90" height="80" rx="4" fill="#C5DFB0" opacity="0.7" />
      <rect x="0" y="118" width="420" height="18" fill="#F5F1EB" />
      <rect x="0" y="195" width="420" height="14" fill="#F5F1EB" />
      <rect x="72"  y="0" width="18" height="310" fill="#F5F1EB" />
      <rect x="188" y="0" width="18" height="310" fill="#F5F1EB" />
      <rect x="308" y="0" width="14" height="310" fill="#F5F1EB" />
      <line x1="0" y1="68"  x2="420" y2="68"  stroke="#E8E2D9" strokeWidth="6" />
      <line x1="0" y1="158" x2="420" y2="158" stroke="#E8E2D9" strokeWidth="5" />
      <line x1="140" y1="0" x2="140" y2="310" stroke="#E8E2D9" strokeWidth="6" />
      <line x1="255" y1="0" x2="255" y2="310" stroke="#E8E2D9" strokeWidth="5" />
      <text x="10" y="116" fontSize="7" fill="#B0A898" fontFamily="sans-serif">Av. Arequipa</text>
      <text x="10" y="193" fontSize="7" fill="#B0A898" fontFamily="sans-serif">Av. Javier Prado</text>
      <polyline points="30,285 30,248 81,248 81,136 197,136 197,127 315,127 315,68 380,68"
        fill="none" stroke="#3B82F6" strokeWidth="3" strokeDasharray="7,5"
        strokeLinecap="round" strokeLinejoin="round" opacity="0.75" />
      {showStop && (
        <>
          <circle cx="315" cy="68" r="14" fill="white" stroke="#3B82F6" strokeWidth="2.5" opacity="0.95" />
          <circle cx="315" cy="68" r="5" fill="#3B82F6" />
        </>
      )}
      {showBus && (
        <circle cx="30" cy="275" r="18" fill="#0B1F3A" stroke="white" strokeWidth="2.5" />
      )}
    </svg>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function AppPasajero() {

  const [initing,        setIniting]        = useState(true);
  const [pasajero,       setPasajero]       = useState<Pasajero | null>(null);
  const [tab,            setTab]            = useState<Tab>("ruta");
  const [dniInput,       setDniInput]       = useState("");
  const [pinInput,       setPinInput]       = useState("");
  const [loginErr,       setLoginErr]       = useState("");
  const [loginLoad,      setLoginLoad]      = useState(false);
  const [miParada,       setMiParada]       = useState<(Parada & { reserva: Reserva }) | null>(null);
  const [vehiculo,       setVehiculo]       = useState<Vehiculo | null>(null);
  const [conductor,      setConductor]      = useState<Conductor | null>(null);
  const [busPosicion,    setBusPosicion]    = useState<UbicacionBus | null>(null);
  const [etaMin,         setEtaMin]         = useState<number | null>(null);
  const [distM,          setDistM]          = useState<number | null>(null);
  const [estadoBus,      setEstadoBus]      = useState<EstadoBus>("no_iniciado");
  const [miEstado,       setMiEstado]       = useState("esperando");
  const [rutaParadas,    setRutaParadas]    = useState<Parada[]>([]);
  const [alerta5min,     setAlerta5min]     = useState(false);
  const [alertaDismiss,  setAlertaDismiss]  = useState(false);
  const [agoMin,         setAgoMin]         = useState<number>(0); // minutos desde última señal del bus
  const [copiado,        setCopiado]        = useState(false);
  const [uploading,      setUploading]      = useState(false);
  const [fotoErr,        setFotoErr]        = useState("");

  // ── GPS PROPIO DEL PASAJERO ─────────────────────────────────────────────────
  const [gpsPermiso,     setGpsPermiso]     = useState<GpsPermiso>("unknown");
  const [gpsPropio,      setGpsPropio]      = useState<{ lat: number; lng: number } | null>(null);
  const [mostrarModalGPS, setMostrarModalGPS] = useState(false);

  // ── REPORTE AL OPERADOR ─────────────────────────────────────────────────────
  const [mostrarReporte,  setMostrarReporte]  = useState(false);
  const [reporteMensaje,  setReporteMensaje]  = useState("");
  const [reporteTipo,     setReporteTipo]     = useState("");
  const [reporteEnviando, setReporteEnviando] = useState(false);
  const [reporteEnviado,  setReporteEnviado]  = useState(false);

  // ── MODAL NAVEGACIÓN ────────────────────────────────────────────────────────
  const [mostrarNavModal,    setMostrarNavModal]    = useState(false);
  const [mostrarParadasModal, setMostrarParadasModal] = useState(false);

  const alertaRef    = useRef(false);
  const watchRef     = useRef<GeoWatch | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const busMarker    = useRef<mapboxgl.Marker | null>(null);
  const paradaMk     = useRef<mapboxgl.Marker | null>(null);
  const meMk         = useRef<mapboxgl.Marker | null>(null);  // marcador pasajero
  const [mapListo,   setMapListo]           = useState(false);

  useEffect(() => {
    const saved = loadSession();
    if (saved) { setPasajero(saved); cargarMiRuta(saved.id); }
    setIniting(false);
    // Service Worker: cachea el shell para arranques instantáneos y resistencia a red.
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // ── SOLICITAR GPS DEL DISPOSITIVO ──────────────────────────────────────────
  // Se dispara automáticamente al loguearse. El navegador muestra la alerta nativa del OS.

  // manual = true cuando el usuario toca "Activar" a propósito. Solo en ese caso
  // mostramos el modal grande de instrucciones si el permiso quedó denegado. El
  // intento automático del login nunca abre el modal — para no interponerse con
  // el diálogo nativo del sistema; deja solo el banner pequeño.
  const solicitarGPS = useCallback(async (manual = false) => {
    setMostrarModalGPS(false); // nunca competir con el diálogo nativo
    if (!geoDisponible()) {
      setGpsPermiso("unavailable");
      return;
    }
    // En la app nativa esto dispara el diálogo de permisos del sistema
    // (igual que Maps/inDrive). En web el permiso se pide al leer la posición.
    const permiso = await pedirPermisoUbicacion();
    if (permiso === "denied") {
      setGpsPermiso("denied");
      if (manual) setMostrarModalGPS(true);
      return;
    }
    if (permiso === "unavailable") {
      setGpsPermiso("unavailable");
      return;
    }
    try {
      const pos = await obtenerUbicacion({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
      setGpsPermiso("granted");
      setGpsPropio({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setMostrarModalGPS(false);
      // Seguir actualizando posición
      if (watchRef.current) watchRef.current.clear();
      watchRef.current = await observarUbicacion(
        (p) => setGpsPropio({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    } catch (err: any) {
      if (err?.code === 1 /* PERMISSION_DENIED */) {
        setGpsPermiso("denied");
        if (manual) setMostrarModalGPS(true); // instrucciones solo si lo pidió a propósito
      } else {
        setGpsPermiso("unavailable");
      }
    }
  }, []);

  // Pedir GPS cuando el pasajero se loguea
  useEffect(() => {
    if (!pasajero) return;
    // Pequeño delay para que el mapa cargue primero
    const t = setTimeout(() => { void solicitarGPS(); }, 1500);
    return () => {
      clearTimeout(t);
      if (watchRef.current) { watchRef.current.clear(); watchRef.current = null; }
    };
  }, [pasajero, solicitarGPS]);

  // Mapbox init
  useEffect(() => {
    if (!mapContainer.current || map.current || !pasajero) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-77.0428, -12.0464],
      zoom: 13,
    });
    map.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.current.on("load", () => setMapListo(true));
    return () => { map.current?.remove(); map.current = null; };
  }, [pasajero]);

  // ── MARCADOR UBICACIÓN PROPIA (punto azul) ──────────────────────────────────
  useEffect(() => {
    if (!mapListo || !map.current || !gpsPropio) return;
    const lngLat: [number, number] = [gpsPropio.lng, gpsPropio.lat];
    if (meMk.current) {
      meMk.current.setLngLat(lngLat);
    } else {
      const el = document.createElement("div");
      el.className = "afa-me-mk";
      el.title = "Tu ubicación";
      meMk.current = new mapboxgl.Marker({ element: el })
        .setLngLat(lngLat)
        .addTo(map.current!);
    }
  }, [gpsPropio, mapListo]);

  // Bus marker + ETA
  useEffect(() => {
    if (!mapListo || !map.current || !busPosicion) return;
    if (busMarker.current) {
      busMarker.current.setLngLat([Number(busPosicion.lng), Number(busPosicion.lat)]);
      // Semitransparente si sin señal
      const el = busMarker.current.getElement();
      if (el) el.style.opacity = estadoBus === "sin_señal" ? "0.45" : "1";
    } else {
      const el = document.createElement("div");
      el.className = "afa-bus-mk";
      el.style.opacity = estadoBus === "sin_señal" ? "0.45" : "1";
      el.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h20"/><path d="M4 19h2a1 1 0 0 0 1-1v-2h10v2a1 1 0 0 0 1 1h2"/><path d="M4 18V8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10"/><circle cx="8" cy="16" r="1" fill="white" stroke="none"/><circle cx="16" cy="16" r="1" fill="white" stroke="none"/></svg>`;
      busMarker.current = new mapboxgl.Marker({ element: el })
        .setLngLat([Number(busPosicion.lng), Number(busPosicion.lat)])
        .setPopup(new mapboxgl.Popup({ offset: 30 }).setHTML(
          `<div style="font-family:'DM Sans',sans-serif;padding:4px">
            <p style="font-weight:800;color:#0B1F3A;margin:0 0 4px">${vehiculo?.placa || "Bus AFA"}</p>
            <p style="color:#555;font-size:12px;margin:0">🚀 ${busPosicion.velocidad} km/h</p>
            ${conductor ? `<p style="color:#555;font-size:12px;margin:4px 0 0">👤 ${conductor.nombre}</p>` : ""}
          </div>`
        )).addTo(map.current!);
    }
    if (miParada?.lat && miParada?.lng) {
      const d   = dist(Number(busPosicion.lat), Number(busPosicion.lng), Number(miParada.lat), Number(miParada.lng));
      const eta = calcETA(d, busPosicion.velocidad);
      setDistM(d); setEtaMin(eta);
      if (eta <= 5 && !alertaRef.current && miEstado !== "embarcado") {
        alertaRef.current = true; setAlerta5min(true); setAlertaDismiss(false);
        if ("vibrate" in navigator) navigator.vibrate([300, 100, 300]);
      }
      const ago = (Date.now() - new Date(busPosicion.timestamp).getTime()) / 60000;
      setAgoMin(Math.round(ago));
      if      (ago > 5)                            setEstadoBus("sin_señal");
      else if (busPosicion.estado === "finalizado") setEstadoBus("finalizado");
      else if (busPosicion.velocidad < 3)           setEstadoBus("retrasado");
      else                                          setEstadoBus("en_camino");
      const b = new mapboxgl.LngLatBounds();
      b.extend([Number(busPosicion.lng), Number(busPosicion.lat)]);
      b.extend([Number(miParada.lng), Number(miParada.lat)]);
      map.current?.fitBounds(b, { padding: 80, maxZoom: 15, duration: 1500 });
    }
  }, [busPosicion, mapListo, miParada, vehiculo, conductor, miEstado]);

  // Parada marker
  useEffect(() => {
    if (!mapListo || !map.current || !miParada?.lat || paradaMk.current) return;
    const el = document.createElement("div");
    el.className = "afa-stop-mk";
    const pulse = document.createElement("div"); pulse.className = "afa-pulse"; el.appendChild(pulse);
    const ico = document.createElement("div"); ico.style.cssText = "display:flex;align-items:center;"; ico.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#0b315f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`; el.appendChild(ico);
    paradaMk.current = new mapboxgl.Marker({ element: el })
      .setLngLat([Number(miParada.lng), Number(miParada.lat)])
      .setPopup(new mapboxgl.Popup({ offset: 30 }).setHTML(
        `<div style="font-family:'DM Sans',sans-serif;padding:4px">
          <p style="font-weight:800;color:#0B1F3A;margin:0 0 4px">Tu paradero</p>
          <p style="color:#555;font-size:12px;margin:0">${miParada.nombre}</p>
          ${miParada.hora_estimada ? `<p style="color:#555;font-size:11px;margin:4px 0 0">🕐 ${miParada.hora_estimada}</p>` : ""}
        </div>`
      )).addTo(map.current!);
    map.current.flyTo({ center: [Number(miParada.lng), Number(miParada.lat)], zoom: 14, duration: 1500 });
  }, [miParada, mapListo]);

  // Línea ruta
  useEffect(() => {
    if (!mapListo || !map.current || rutaParadas.length < 2) return;
    const coords = rutaParadas.filter(p => p.lat && p.lng).map(p => [Number(p.lng), Number(p.lat)]);
    if (coords.length < 2) return;
    if (map.current.getSource("ruta")) {
      (map.current.getSource("ruta") as mapboxgl.GeoJSONSource).setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
    } else {
      map.current.addSource("ruta", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
      map.current.addLayer({ id: "ruta-line", type: "line", source: "ruta", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#3B82F6", "line-width": 3, "line-dasharray": [2, 2], "line-opacity": 0.7 } });
    }
  }, [rutaParadas, mapListo]);

  // Posición del bus en vivo — polling vía API (Realtime no funciona para anónimo
  // con RLS activo). El conductor envía ubicación cada ~15 s; consultamos cada 8 s.
  useEffect(() => {
    if (!miParada?.reserva?.vehiculo_id) return;
    const vid = miParada.reserva.vehiculo_id;
    let activo = true;
    const tick = async () => {
      try {
        const { busPosicion } = await paxApi("bus_posicion", { vehiculoId: vid });
        if (activo && busPosicion) setBusPosicion(busPosicion as UbicacionBus);
      } catch { /* reintentará en el próximo tick */ }
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => { activo = false; clearInterval(id); };
  }, [miParada]);

  // ── FUNCIONES ───────────────────────────────────────────────────────────────

  async function login() {
    if (dniInput.length < 7) { setLoginErr("Ingresa tu DNI completo"); return; }
    if (pinInput.length < 4) { setLoginErr("Ingresa tu PIN de 4 dígitos"); return; }
    setLoginErr(""); setLoginLoad(true);
    let data: any = null;
    try {
      const r = await paxApi("login", { dni: dniInput.trim() });
      data = r.pasajero;
    } catch (e: any) { setLoginErr(`Error: ${e?.message ?? "no se pudo conectar"}`); setLoginLoad(false); return; }
    if (!data) { setLoginErr("DNI no registrado. Contacta a tu empresa o a AFA Tours."); setLoginLoad(false); return; }
    // Validar PIN — si no tiene PIN asignado, usar últimos 4 dígitos del DNI como default
    const pinEsperado = data.pin_acceso || dniInput.trim().slice(-4);
    if (pinInput !== pinEsperado) { setLoginErr("PIN incorrecto. Intenta con los últimos 4 dígitos de tu DNI."); setLoginLoad(false); return; }
    saveSession(data); setPasajero(data); await cargarMiRuta(data.id); setLoginLoad(false);
  }

  const cargarMiRuta = useCallback(async (pid: number) => {
    const hoy = getFechaLocal();
    let r: any;
    try {
      // Via service_role (saltea RLS) — el pasajero es anónimo.
      r = await paxApi("ruta", { pid, hoy });
    } catch (e: any) {
      console.error("[cargarMiRuta]", e?.message);
      return;
    }
    if (!r || r.ruta === null || !r.miParada) return;
    setMiParada(r.miParada);
    setMiEstado(r.miEstado || "esperando");
    setRutaParadas(r.rutaParadas || []);
    if (r.vehiculo)    setVehiculo(r.vehiculo);
    if (r.busPosicion) setBusPosicion(r.busPosicion);
    if (r.conductor)   setConductor(r.conductor);
  }, []);

  function abrirWaze() {
    if (!miParada) return;
    window.open(miParada.lat && miParada.lng
      ? `https://waze.com/ul?ll=${miParada.lat},${miParada.lng}&navigate=yes&zoom=17`
      : `https://waze.com/ul?q=${encodeURIComponent((miParada.direccion || miParada.nombre) + ", Lima, Peru")}&navigate=yes`, "_blank");
  }
  function abrirMaps() {
    if (!miParada) return;
    const dest = miParada.lat && miParada.lng ? `${miParada.lat},${miParada.lng}` : encodeURIComponent((miParada.direccion || miParada.nombre) + ", Lima, Peru");
    // Si tenemos la ubicación propia, usarla como origen
    const origin = gpsPropio ? `&origin=${gpsPropio.lat},${gpsPropio.lng}` : "";
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}${origin}&travelmode=walking`, "_blank");
  }
  function centrarMapa() {
    if (!map.current) return;
    const b = new mapboxgl.LngLatBounds();
    let hasPoints = false;
    if (busPosicion) { b.extend([Number(busPosicion.lng), Number(busPosicion.lat)]); hasPoints = true; }
    if (miParada?.lat && miParada?.lng) { b.extend([Number(miParada.lng), Number(miParada.lat)]); hasPoints = true; }
    if (gpsPropio) { b.extend([gpsPropio.lng, gpsPropio.lat]); hasPoints = true; }
    if (hasPoints) map.current.fitBounds(b, { padding: 80, maxZoom: 15, duration: 1000 });
  }
  async function compartir() {
    const txt = `🚌 Seguimiento AFA Tours\n📍 Paradero: ${miParada?.nombre || ""}\n🕐 Hora: ${miParada?.hora_estimada || "—"}\n\n${window.location.href}`;
    try {
      if (navigator.share) await navigator.share({ title: "Mi bus AFA Tours", text: txt });
      else { await navigator.clipboard.writeText(txt); setCopiado(true); setTimeout(() => setCopiado(false), 3000); }
    } catch { /* noop */ }
  }
  async function uploadFoto(file: File) {
    if (!pasajero) return;
    setFotoErr(""); setUploading(true);
    try {
      const bitmap = await createImageBitmap(file);
      const MAX = 800, ratio = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
      const w = Math.round(bitmap.width * ratio), h = Math.round(bitmap.height * ratio);
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise<Blob>(res => canvas.toBlob(b => res(b!), "image/jpeg", 0.85));
      const path = `${pasajero.id}/foto_${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage.from("pasajeros-fotos").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = supabase.storage.from("pasajeros-fotos").getPublicUrl(path);
      await paxApi("foto", { pid: pasajero.id, fotoUrl: publicUrl });
      const updated = { ...pasajero, foto_url: publicUrl }; setPasajero(updated); saveSession(updated);
    } catch (e: any) {
      setFotoErr(e?.message || "Error al subir la foto.");
    } finally { setUploading(false); }
  }
  async function enviarReporte() {
    if (!pasajero || !miParada) return;
    const texto = reporteMensaje.trim() || reporteTipo;
    if (!texto) return;
    setReporteEnviando(true);
    try {
      await paxApi("mensaje", { mensaje: {
        pasajero_id: pasajero.id,
        reserva_id:  miParada.reserva_id,
        parada_id:   miParada.id,
        tipo:        reporteTipo || "novedad",
        mensaje:     texto,
      } });
    } catch (e: any) {
      setReporteEnviando(false);
      return; // no marcar como enviado si falló
    }
    setReporteEnviando(false);
    setReporteEnviado(true);
    setReporteMensaje("");
    setReporteTipo("");
    setTimeout(() => {
      setReporteEnviado(false);
      setMostrarReporte(false);
    }, 2500);
  }

  function salir() {
    clearSession(); setPasajero(null); setMiParada(null); setBusPosicion(null); setRutaParadas([]);
    setVehiculo(null); setConductor(null); setGpsPropio(null); setGpsPermiso("unknown");
    setDniInput(""); setPinInput("");
    alertaRef.current = false; setAlerta5min(false); setTab("ruta");
  }

  // Derivados
  const busActivo = busPosicion && estadoBus !== "finalizado" && estadoBus !== "sin_señal";
  const pct       = distM !== null ? Math.max(0, Math.min(100, 100 - (distM / 5000) * 100)) : 0;

  // ── LOADING ─────────────────────────────────────────────────────────────────
  if (initing) return (
    <>
      <style>{CSS}</style>
      <div className="afa-backdrop" />
      <div style={{ position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 420, height: "100vh", zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: "var(--paper)" }}>
        <CondorMark size={48} color="var(--navy)" />
        <div className="afa-spin" />
      </div>
    </>
  );

  // ── LOGIN ────────────────────────────────────────────────────────────────────
  if (!pasajero) return (
    <>
      <style>{CSS}</style>
      <div className="afa-backdrop" />
      <div className="afa-login">
        <div className="afa-login-body">

        {/* HERO */}
        <div style={{ padding: "48px 28px 24px" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
            <img src="/Logoafapasajeros3.png" alt="AFA Pasajero" style={{ height: 72, objectFit: "contain", display: "block" }} />
          </div>
          <h1 style={{ fontFamily: "var(--f)", fontWeight: 800, fontSize: 30, letterSpacing: -1.2, color: "var(--ink)", margin: "0 0 6px", lineHeight: 1.05 }}>
            Bienvenido a bordo.
          </h1>
          <p style={{ color: "var(--mute)", fontSize: 14, margin: 0, lineHeight: 1.5 }}>
            Ingresa tu DNI y PIN para ver tu bus en vivo y abordar con QR.
          </p>
        </div>

        {/* FORM CARD */}
        <div style={{ padding: "0 24px" }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 22, padding: 20, boxShadow: "0 1px 0 rgba(0,0,0,0.02)" }}>

            {/* DNI */}
            <Eyebrow>Documento de identidad</Eyebrow>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 4px 10px", borderBottom: `1.5px solid ${dniInput.length >= 7 ? "var(--navy)" : "var(--line)"}`, marginTop: 10, marginBottom: 16 }}>
              <span style={{ fontFamily: "var(--m)", fontSize: 13, color: "var(--mute2)", fontWeight: 600, flexShrink: 0 }}>PE</span>
              <input
                type="tel" inputMode="numeric" maxLength={8} value={dniInput}
                onChange={e => { setDniInput(e.target.value.replace(/\D/g, "").slice(0, 8)); setLoginErr(""); }}
                onKeyDown={e => e.key === "Enter" && login()}
                placeholder="12345678"
                style={{ fontFamily: "var(--m)", fontSize: 26, fontWeight: 700, color: "var(--ink)", letterSpacing: 3, flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent" }}
              />
            </div>

            {/* PIN */}
            <div style={{ marginBottom: 10 }}>
              <Eyebrow>PIN de acceso</Eyebrow>
            </div>
            <div style={{ padding: "8px 4px 12px", borderBottom: `1.5px solid ${pinInput.length === 4 ? "var(--navy)" : "var(--line)"}`, marginBottom: 18 }}>
              <input
                type="password" inputMode="numeric" maxLength={4} value={pinInput}
                onChange={e => { setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4)); setLoginErr(""); }}
                onKeyDown={e => e.key === "Enter" && login()}
                placeholder="••••"
                style={{ fontFamily: "var(--m)", fontSize: 32, fontWeight: 700, color: "var(--ink)", letterSpacing: 10, width: "100%", border: "none", outline: "none", background: "transparent" }}
              />
            </div>

            {loginErr && <div className="afa-login-err">{loginErr}</div>}

            <button onClick={login} disabled={loginLoad || dniInput.length < 7 || pinInput.length < 4}
              style={{
                width: "100%", padding: "14px 20px", borderRadius: 14, border: "none",
                background: (dniInput.length >= 7 && pinInput.length === 4) ? "var(--navy)" : "var(--line)",
                color: (dniInput.length >= 7 && pinInput.length === 4) ? "#fff" : "var(--mute2)",
                fontFamily: "var(--f)", fontWeight: 700, fontSize: 15, cursor: (dniInput.length >= 7 && pinInput.length === 4) ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                boxShadow: (dniInput.length >= 7 && pinInput.length === 4) ? "0 6px 16px -8px rgba(11,49,95,0.4)" : "none",
                transition: "all 0.2s",
              }}>
              {loginLoad ? "Verificando…" : <><span>Ver mi ruta</span><IconArrowRight sz={18} c="white" /></>}
            </button>
          </div>
        </div>

        {/* FEATURE CARDS */}
        <div style={{ padding: "20px 24px 0" }}>
          <p style={{ fontFamily: "var(--f)", fontSize: 10, fontWeight: 700, color: "var(--mute)", letterSpacing: 1.2, textTransform: "uppercase", margin: "0 0 10px", textAlign: "center" }}>Tu viaje, en una app</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
            {[
              { i: <IconBus sz={20} c="var(--navy)" />, t: "Bus en vivo", d: "ETA en tiempo real" },
              { i: <IconBell sz={20} c="var(--navy)" />, t: "Te avisamos", d: "Cuando esté a 5 min" },
              { i: <IconQR sz={20} c="var(--navy)" />, t: "Pase QR", d: "Sin papel, sin filas" },
            ].map((x, i) => (
              <div key={i} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: "14px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
                <div style={{ width: 38, height: 38, borderRadius: 11, background: "var(--navy-tint)", display: "flex", alignItems: "center", justifyContent: "center" }}>{x.i}</div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 12.5, color: "var(--ink)", letterSpacing: -0.1, lineHeight: 1.2 }}>{x.t}</p>
                <p style={{ margin: 0, color: "var(--mute)", fontSize: 11, lineHeight: 1.3 }}>{x.d}</p>
              </div>
            ))}
          </div>
        </div>

        {/* FOOTER */}
        <div style={{ padding: "20px 24px 36px", textAlign: "center", borderTop: "1px solid var(--line2)", marginTop: 20, background: "var(--surface)" }}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--mute)" }}>
            ¿Problemas para entrar?{" "}
            <a href="tel:013453707" style={{ color: "var(--navy)", fontWeight: 700, textDecoration: "none" }}>Llamar a soporte · 01 3453707</a>
          </p>
        </div>
        </div>{/* /afa-login-body */}
      </div>
    </>
  );

  // ── APP ──────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div className="afa-backdrop" />

      {/* ── MODAL GPS DESACTIVADO ── */}
      {mostrarModalGPS && (
        <ModalActivarGPS
          onReintentar={() => { setMostrarModalGPS(false); void solicitarGPS(true); }}
          onCerrar={() => setMostrarModalGPS(false)}
        />
      )}

      {/* ── MODAL ELEGIR APP DE NAVEGACIÓN ── */}
      {mostrarNavModal && (
        <div className="afa-modal-overlay" onClick={() => setMostrarNavModal(false)}>
          <div className="afa-modal-sheet" onClick={e => e.stopPropagation()}>
            <div className="afa-modal-handle" />
            <div style={{ padding: "0 24px 8px", textAlign: "center" }}>
              <div style={{ width: 52, height: 52, borderRadius: 16, background: "var(--navy-tint)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                <IconNav sz={24} c="var(--navy)" />
              </div>
              <div className="afa-modal-title">¿Cómo quieres llegar?</div>
              <div className="afa-modal-desc">
                Elige tu app para llegar a <strong style={{ color: "var(--ink)" }}>{miParada?.nombre || "tu paradero"}</strong>
              </div>
            </div>
            <div className="afa-modal-btns" style={{ marginTop: 16 }}>
              <button
                onClick={() => { abrirWaze(); setMostrarNavModal(false); }}
                style={{ width: "100%", padding: "15px 20px", borderRadius: 14, border: "none", background: "#33CCFF", color: "#082035", fontFamily: "var(--f)", fontWeight: 800, fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}
              >
                <svg width="22" height="22" viewBox="0 0 36 36" style={{ flexShrink: 0 }}>
                  <circle cx="18" cy="18" r="18" fill="#33CCFF"/>
                  <ellipse cx="18" cy="16" rx="8" ry="8" fill="white"/>
                  <circle cx="14.5" cy="14.5" r="2" fill="#082035"/>
                  <circle cx="21.5" cy="14.5" r="2" fill="#082035"/>
                  <path d="M14 19 Q18 23 22 19" stroke="#082035" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
                </svg>
                Abrir en Waze
              </button>
              <button
                onClick={() => { abrirMaps(); setMostrarNavModal(false); }}
                style={{ width: "100%", padding: "15px 20px", borderRadius: 14, border: "none", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--f)", fontWeight: 800, fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxShadow: "inset 0 0 0 1.5px var(--line)" }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#EA4335"/>
                  <circle cx="12" cy="9" r="2.5" fill="white"/>
                </svg>
                Abrir en Google Maps
              </button>
              <button className="afa-modal-btn-s" onClick={() => setMostrarNavModal(false)}>
                Cancelar
              </button>
            </div>
            <div style={{ height: 8 }} />
          </div>
        </div>
      )}

      {/* ── MODAL PARADAS DEL RECORRIDO ── */}
      {mostrarParadasModal && rutaParadas.length > 0 && (() => {
        const miIdx       = rutaParadas.findIndex(p => p.id === miParada?.id);
        const primerP     = rutaParadas[0];
        const ultimaP     = rutaParadas[rutaParadas.length - 1];
        const miOrden     = miIdx + 1;
        return (
          <div className="afa-modal-overlay" onClick={() => setMostrarParadasModal(false)}>
            <div className="afa-para-sheet" onClick={e => e.stopPropagation()}>
              <div className="afa-modal-handle" />

              {/* Header */}
              <div className="afa-para-hdr">
                <div className="afa-para-hdr-top">
                  <button
                    onClick={() => setMostrarParadasModal(false)}
                    style={{
                      width: 34, height: 34, borderRadius: "50%",
                      border: "1.5px solid var(--line)", background: "var(--surface)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", color: "var(--mute)", flexShrink: 0,
                    }}
                  >
                    <IconClose sz={17} c="var(--mute)" />
                  </button>
                  <div className="afa-para-hdr-title">
                    {miOrden > 0 ? `#${miOrden} · ` : ""}Paradas del recorrido
                  </div>
                  <span className="afa-para-cnt-badge">{rutaParadas.length} paradas</span>
                </div>

                {/* Summary strip */}
                <div className="afa-para-summary">
                  <div className="afa-para-sum-col">
                    <span className="afa-para-sum-lbl">Origen</span>
                    <span className="afa-para-sum-val">{primerP.nombre.split(" ").slice(0, 2).join(" ")}</span>
                    <span className="afa-para-sum-time">{primerP.hora_estimada || miParada?.reserva?.hora_servicio || "—"}</span>
                  </div>
                  <div className="afa-para-sum-col mid">
                    <span className="afa-para-sum-lbl">Tu parada</span>
                    <span className="afa-para-sum-val">{miOrden > 0 ? `#${miOrden}` : "—"}</span>
                    <span className="afa-para-sum-time">{miParada?.hora_estimada || "—"}</span>
                  </div>
                  <div className="afa-para-sum-col last">
                    <span className="afa-para-sum-lbl">Destino</span>
                    <span className="afa-para-sum-val">{ultimaP.nombre.split(" ").slice(0, 2).join(" ")}</span>
                    <span className="afa-para-sum-time">{ultimaP.hora_estimada || "—"}</span>
                  </div>
                </div>
              </div>

              {/* Timeline scrollable */}
              <div className="afa-para-scroll">
                {rutaParadas.map((p, i) => {
                  const esMia   = p.id === miParada?.id;
                  const isDone  = p.estado === "completada";
                  const isFut   = !isDone && !esMia;
                  const state   = isDone ? "p-done" : esMia ? "p-cur" : "p-fut";
                  const segNext = i < rutaParadas.length - 1;
                  const segDone = rutaParadas[i + 1]?.estado === "completada" || (rutaParadas[i + 1]?.id === miParada?.id ? false : !isDone ? false : true);
                  const lineClass = isDone ? "s-done" : "s-fut";
                  return (
                    <div key={p.id} className="afa-para-row">
                      {/* Spine: node + connecting line */}
                      <div className="afa-para-spine">
                        <div className={`afa-para-node ${state}`}>
                          {isDone && <IconCheck sz={14} c="#fff" sw={2.5} />}
                          {esMia && <IconPin sz={14} c="#fff" />}
                        </div>
                        {segNext && <div className={`afa-para-seg ${lineClass}`} />}
                      </div>

                      {/* Content */}
                      <div className="afa-para-content">
                        <div className={`afa-para-inner${esMia ? " p-cur" : ""}`}>
                          <div className="afa-para-rhead">
                            <div style={{ flex: 1 }}>
                              <div className={`afa-para-name ${state}`}>{p.nombre}</div>
                              {p.direccion && <div className="afa-para-addr">{p.direccion}</div>}
                              {esMia && (
                                <div className="afa-para-tags">
                                  <span className="afa-para-tag-m">
                                    <IconPin sz={10} c="var(--navy)" /> Tu paradero
                                  </span>
                                  {etaMin !== null && etaMin > 0 && (
                                    <span className="afa-para-tag-e">
                                      <IconClock sz={10} c="var(--warn)" /> En {fmtETA(etaMin)}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            {p.hora_estimada && (
                              <span className={`afa-para-tval${esMia ? " p-cur" : ""}`}>{p.hora_estimada}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── MODAL REPORTE AL OPERADOR ── */}
      {mostrarReporte && (
        <div className="afa-modal-overlay" onClick={() => !reporteEnviando && setMostrarReporte(false)}>
          <div className="afa-modal-sheet" onClick={e => e.stopPropagation()}>
            <div className="afa-modal-handle" />
            {reporteEnviado ? (
              <div style={{ padding: "20px 24px 32px", textAlign: "center" }}>
                <div style={{ width: 72, height: 72, borderRadius: 24, background: "var(--success-tint)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                  <IconCheck sz={32} c="var(--success)" sw={2.5} />
                </div>
                <p style={{ color: "var(--ink)", fontWeight: 800, fontSize: 18, margin: "0 0 8px", letterSpacing: -0.3 }}>Mensaje enviado</p>
                <p style={{ color: "var(--mute)", fontSize: 13 }}>El operador fue notificado y te ayudará a la brevedad</p>
              </div>
            ) : (
              <>
                <div style={{ padding: "0 24px 16px", textAlign: "center" }}>
                  <div style={{ width: 56, height: 56, background: "var(--navy-tint)", borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                    <IconMessageCircle sz={26} c="var(--navy)" />
                  </div>
                  <div className="afa-modal-title">Reportar al operador</div>
                  <div className="afa-modal-desc">Selecciona el motivo. El operador lo recibe al instante.</div>
                </div>
                <div style={{ padding: "0 24px", marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { tipo: "tardanza",    txt: "Llegaré tarde a mi paradero" },
                    { tipo: "cancelacion", txt: "No podré tomar el servicio hoy" },
                    { tipo: "incidencia",  txt: "El bus ya pasó sin recogerme" },
                    { tipo: "otro",        txt: "Otro motivo..." },
                  ].map(op => (
                    <button key={op.tipo} className={`afa-reporte-opt${reporteTipo === op.tipo ? " sel" : ""}`}
                      onClick={() => { setReporteTipo(op.tipo); if (op.tipo !== "otro") setReporteMensaje(""); }}>
                      {op.txt}
                      {reporteTipo === op.tipo && <span style={{ marginLeft: "auto" }}><IconCheck sz={16} c="var(--navy)" /></span>}
                    </button>
                  ))}
                </div>
                {(reporteTipo === "otro" || reporteTipo) && (
                  <div style={{ padding: "0 24px", marginBottom: 16 }}>
                    <textarea rows={3} placeholder={reporteTipo === "otro" ? "Describe tu situación..." : "Agregar detalle (opcional)..."}
                      value={reporteMensaje} onChange={e => setReporteMensaje(e.target.value)}
                      style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1.5px solid var(--line)", fontSize: 13, fontFamily: "var(--f)", resize: "none", outline: "none", color: "var(--ink)", boxSizing: "border-box" }} />
                  </div>
                )}
                <div className="afa-modal-btns">
                  <button className="afa-modal-btn-p" disabled={reporteEnviando || (!reporteTipo && !reporteMensaje.trim())}
                    style={{ opacity: (!reporteTipo && !reporteMensaje.trim()) ? 0.4 : 1 }} onClick={enviarReporte}>
                    {reporteEnviando ? "Enviando..." : "Enviar al operador"}
                  </button>
                  <button className="afa-modal-btn-s" onClick={() => setMostrarReporte(false)}>Cancelar</button>
                </div>
                <div style={{ height: 8 }} />
              </>
            )}
          </div>
        </div>
      )}

      <div className="afa-app">

        {/* ══════════ TAB RUTA — fullscreen map ══════════ */}
        {tab === "ruta" && (
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            {/* Map layer */}
            <MapaCiudad showBus={!busPosicion} showStop={!!miParada} />
            <div ref={mapContainer} style={{ position: "absolute", inset: 0, opacity: mapListo ? 1 : 0, transition: "opacity 0.8s ease" }} />

            {/* Header overlay */}
            <div className="afa-map-hdr">
              <div style={{ background: "rgba(255,255,255,0.9)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 999, padding: "6px 8px 6px 12px", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 14px rgba(11,49,95,0.12)", border: "1px solid var(--line2)" }}>
                <CondorMark size={18} color="var(--navy)" />
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)", letterSpacing: -0.1 }}>{pasajero.nombre.split(" ").slice(0, 2).join(" ")}</span>
                <div style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--navy)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 11 }}>{ini(pasajero.nombre)}</div>
              </div>
              <div style={{ background: estadoBus === "sin_señal" ? "var(--warn-tint)" : "white", borderRadius: 999, padding: "7px 12px", display: "flex", alignItems: "center", gap: 7, boxShadow: "0 4px 14px rgba(0,0,0,0.08)", border: `1px solid ${estadoBus === "sin_señal" ? "rgba(180,83,9,0.2)" : "var(--line2)"}` }}>
                <StatusDot color={estadoBus === "en_camino" ? "var(--success)" : estadoBus === "retrasado" ? "var(--warn)" : estadoBus === "sin_señal" ? "var(--warn)" : "var(--mute2)"} size={7} />
                <span style={{ fontWeight: 700, fontSize: 12, color: estadoBus === "sin_señal" ? "var(--warn)" : "var(--ink2)", letterSpacing: -0.1 }}>
                  {estadoBus === "sin_señal" ? "SIN SEÑAL" : estadoBus === "finalizado" ? "FINALIZADO" : !busPosicion ? "ESPERANDO" : "EN VIVO"}
                </span>
              </div>
            </div>

            {/* Arrival banner (≤5 min) */}
            {alerta5min && !alertaDismiss && miEstado !== "embarcado" && (
              <div style={{ position: "absolute", top: 78, left: 14, right: 14, zIndex: 4, background: "var(--navy)", color: "white", borderRadius: 18, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 10px 30px rgba(11,49,95,0.4)", animation: "sheetIn 0.4s cubic-bezier(.2,.7,.3,1)" }}>
                <div style={{ width: 38, height: 38, borderRadius: 12, background: "rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <IconBell sz={20} c="white" />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontWeight: 800, fontSize: 15, letterSpacing: -0.2 }}>Tu bus está llegando</p>
                  <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "rgba(255,255,255,0.78)", letterSpacing: -0.1 }}>{etaMin !== null ? `${etaMin} min` : "< 5 min"}{distM !== null ? ` · ${fmtDist(distM)}` : ""} — dirígete al paradero</p>
                </div>
                <button onClick={() => setAlertaDismiss(true)} style={{ background: "rgba(255,255,255,0.14)", border: "none", width: 28, height: 28, borderRadius: 999, color: "white", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <IconClose sz={15} c="white" sw={2.5} />
                </button>
              </div>
            )}

            {/* GPS denied banner */}
            {gpsPermiso === "denied" && !mostrarModalGPS && (
              <div style={{ position: "absolute", top: alerta5min && !alertaDismiss ? 144 : 78, left: 14, right: 14, zIndex: 3, background: "var(--warn-tint)", borderRadius: 14, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, border: "1px solid rgba(180,83,9,0.2)" }}>
                <IconPin sz={16} c="var(--warn)" />
                <p style={{ flex: 1, margin: 0, fontSize: 12, color: "var(--warn)", fontWeight: 600 }}>GPS desactivado — actívalo para ver tu posición</p>
                <button onClick={() => void solicitarGPS(true)} style={{ background: "var(--warn)", border: "none", borderRadius: 8, padding: "4px 10px", color: "white", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--f)", flexShrink: 0 }}>Activar</button>
              </div>
            )}

            {/* Crosshair button */}
            <button onClick={centrarMapa} style={{ position: "absolute", right: 14, top: "40%", width: 44, height: 44, borderRadius: 14, background: "white", border: "1px solid var(--line2)", boxShadow: "0 4px 14px rgba(0,0,0,0.1)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 3 }}>
              <IconCrosshair sz={20} c="var(--navy)" />
            </button>

            {/* Bottom sheet */}
            <div className="afa-bottom-sheet">
              <div style={{ display: "flex", justifyContent: "center", paddingTop: 8, position: "sticky", top: 0, background: "var(--paper)", zIndex: 1 }}>
                <div style={{ width: 38, height: 4, background: "var(--line)", borderRadius: 4 }} />
              </div>

              {!miParada ? (
                /* ── EMPTY: sin ruta hoy ── */
                <div style={{ padding: "20px 20px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                    <StatusDot color="var(--mute2)" size={7} pulse={false} />
                    <Eyebrow color="var(--mute2)">Sin servicio hoy</Eyebrow>
                  </div>
                  <div style={{ background: "var(--surface)", border: "1px dashed var(--line)", borderRadius: 20, padding: "28px 18px", textAlign: "center", position: "relative", overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0, opacity: 0.03, backgroundImage: `radial-gradient(var(--navy) 1px, transparent 1px)`, backgroundSize: "14px 14px" }} />
                    <div style={{ width: 80, height: 80, margin: "0 auto 14px", borderRadius: 24, background: "var(--navy-tint)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <IconRoute sz={36} c="var(--navy)" />
                    </div>
                    <h3 style={{ margin: 0, fontWeight: 800, fontSize: 17, letterSpacing: -0.4, color: "var(--ink)" }}>No tienes ruta asignada hoy</h3>
                    <p style={{ margin: "8px auto 18px", fontSize: 13, color: "var(--mute)", maxWidth: 260, lineHeight: 1.5 }}>Tu empresa aún no registró tu paradero. Suele actualizarse a partir de las 5:30 a.m.</p>
                    <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                      <button onClick={() => cargarMiRuta(pasajero.id)} style={{ padding: "10px 16px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--f)" }}>
                        <IconBell sz={14} c="var(--navy)" /> Actualizar
                      </button>
                      <a href="tel:013453707" style={{ padding: "10px 16px", borderRadius: 12, border: "none", background: "var(--navy)", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--f)", textDecoration: "none" }}>
                        <IconPhone sz={14} c="white" /> Llamar
                      </a>
                    </div>
                  </div>
                </div>
              ) : estadoBus === "sin_señal" ? (
                /* ── NO GPS ── */
                <div style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--warn-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <IconWifiOff sz={22} c="var(--warn)" />
                    </div>
                    <div>
                      <Eyebrow color="var(--warn)">GPS sin señal</Eyebrow>
                      <p style={{ margin: "4px 0 0", fontWeight: 800, fontSize: 18, color: "var(--ink)", letterSpacing: -0.4 }}>No vemos tu bus ahora mismo</p>
                    </div>
                  </div>
                  <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--mute)", lineHeight: 1.5 }}>Última posición hace {agoMin} min. Puede ser un túnel o falta de señal celular.</p>
                  <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, padding: 14, marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <Eyebrow>Última posición</Eyebrow>
                      <span style={{ fontFamily: "var(--m)", fontSize: 11, color: "var(--mute)", fontWeight: 600 }}>hace {agoMin} min</span>
                    </div>
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      <div style={{ width: 44, height: 44, borderRadius: 12, background: "var(--navy)", display: "flex", alignItems: "center", justifyContent: "center" }}><IconBus sz={22} c="white" /></div>
                      <div>
                        <p style={{ margin: 0, fontFamily: "var(--m)", fontWeight: 700, fontSize: 15, color: "var(--ink)", letterSpacing: 0.4 }}>{vehiculo?.placa || "—"}</p>
                        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--mute)" }}>{conductor?.nombre || "Conductor AFA"}</p>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {conductor?.telefono && <a href={`tel:${conductor.telefono}`} style={{ padding: "12px 14px", borderRadius: 14, background: "var(--ink)", color: "white", border: "none", fontFamily: "var(--f)", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, textDecoration: "none" }}><IconPhone sz={17} c="white" /> Conductor</a>}
                    <button onClick={centrarMapa} style={{ padding: "12px 14px", borderRadius: 14, background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", cursor: "pointer", fontFamily: "var(--f)", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><IconCrosshair sz={17} c="var(--navy)" /> Ver mapa</button>
                  </div>
                </div>
              ) : (
                /* ── TRACKING NORMAL ── */
                <div style={{ padding: "14px 20px 0" }}>
                  {/* Eyebrow status */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <StatusDot color={miEstado === "embarcado" ? "var(--success)" : "var(--navy)"} size={7} />
                    <Eyebrow color={miEstado === "embarcado" ? "var(--success)" : "var(--navy)"}>
                      {miEstado === "embarcado" ? "A bordo · viaje en curso" : estadoBus === "no_iniciado" || !busPosicion ? "Bus aún no inicia" : estadoBus === "retrasado" ? "Bus detenido · tráfico" : "En camino a tu paradero"}
                    </Eyebrow>
                  </div>

                  {/* ETA hero */}
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 10 }}>
                    {busActivo && etaMin !== null ? (
                      <span key={etaMin} style={{ fontFamily: "var(--f)", fontWeight: 800, fontSize: 72, lineHeight: 0.95, color: "var(--ink)", letterSpacing: -3.5, animation: "numIn 0.5s ease", display: "inline-block" }}>{etaMin}</span>
                    ) : (
                      <span style={{ fontFamily: "var(--f)", fontWeight: 800, fontSize: 48, lineHeight: 0.95, color: "var(--mute2)", letterSpacing: -2 }}>—</span>
                    )}
                    <div style={{ paddingBottom: 6 }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "var(--ink)", letterSpacing: -0.3 }}>{busActivo && etaMin !== null ? "min" : "Bus esperando"}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--mute)" }}>{distM !== null ? fmtDist(distM) : miParada.reserva?.hora_servicio ? `Sale: ${miParada.reserva.hora_servicio}` : ""}</p>
                    </div>
                    <div style={{ flex: 1 }} />
                    {/* Arrival time chip */}
                    <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, padding: "8px 12px", alignSelf: "flex-end" }}>
                      <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "var(--mute)", letterSpacing: 0.6, textTransform: "uppercase" }}>{miEstado === "embarcado" ? "Llega destino" : "Llega a las"}</p>
                      <p style={{ margin: "2px 0 0", fontFamily: "var(--m)", fontSize: 18, fontWeight: 700, color: "var(--ink)", letterSpacing: -0.5 }}>{miParada.hora_estimada || miParada.reserva?.hora_servicio || "—"}</p>
                    </div>
                  </div>

                  {/* Progress bar */}
                  {distM !== null && (
                    <div style={{ marginTop: 4, marginBottom: 14 }}>
                      <div style={{ height: 5, background: "var(--line2)", borderRadius: 999, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, var(--navy) 0%, ${alerta5min ? "var(--success)" : "var(--navy)"} 100%)`, borderRadius: 999, transition: "width 1.5s ease" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                        <span style={{ fontSize: 10, color: "var(--mute2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{(miParada.reserva as any)?.origen || "Origen"}</span>
                        <span style={{ fontSize: 10, color: "var(--mute2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{(miParada.reserva as any)?.destino || "Destino"}</span>
                      </div>
                    </div>
                  )}

                  {/* Bus card */}
                  <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 18, padding: 14, display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                    <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--navy)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 6px 14px -4px rgba(11,49,95,0.5)" }}>
                      <IconBus sz={24} c="white" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "var(--m)", fontWeight: 700, fontSize: 17, color: "var(--ink)", letterSpacing: 0.5 }}>{vehiculo?.placa || "—"}</span>
                        {vehiculo?.categoria && <Chip color="var(--navy)" bg="var(--navy-tint)">{vehiculo.categoria}</Chip>}
                      </div>
                      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--mute)", letterSpacing: -0.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conductor?.nombre || "Conductor AFA"}</p>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {conductor?.telefono && (
                        <a href={`tel:${conductor.telefono}`} style={{ width: 38, height: 38, borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>
                          <IconPhone sz={18} c="var(--navy)" />
                        </a>
                      )}
                      <button onClick={compartir} style={{ width: 38, height: 38, borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <IconShare sz={18} c="var(--navy)" />
                      </button>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <button onClick={() => setMostrarNavModal(true)} style={{ padding: "12px 14px", borderRadius: 14, background: "var(--ink)", color: "white", border: "none", cursor: "pointer", fontFamily: "var(--f)", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, letterSpacing: -0.1 }}>
                      <IconNav sz={17} c="white" /> Llegar al paradero
                    </button>
                    <button onClick={() => setMostrarParadasModal(true)} style={{ padding: "12px 14px", borderRadius: 14, background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", cursor: "pointer", fontFamily: "var(--f)", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, letterSpacing: -0.1 }}>
                      <IconRoute sz={17} c="var(--navy)" /> Ver paradas
                    </button>
                  </div>

                  {/* Contact & report */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 4 }}>
                    <a href="tel:966707225" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px", borderRadius: 12, background: "var(--surface)", border: "1px solid var(--line2)", textDecoration: "none", color: "var(--ink)", fontWeight: 600, fontSize: 13, fontFamily: "var(--f)" }}>
                      <IconPhone sz={15} c="var(--navy)" /> Central AFA · 966 707 225
                    </a>
                    <button onClick={() => setMostrarReporte(true)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px", borderRadius: 12, background: "var(--surface)", border: "1px solid var(--line2)", cursor: "pointer", color: "var(--mute)", fontWeight: 600, fontSize: 13, fontFamily: "var(--f)" }}>
                      <IconMessageCircle sz={15} c="var(--mute)" /> Enviar mensaje al operador
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════ TAB QR — boarding pass ══════════ */}
        {tab === "qr" && (
          <div className="afa-scroll">
            <div className="afa-scroll-inner">
            {/* Header */}
            <div style={{ padding: "16px 22px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <Eyebrow>Tu identificación</Eyebrow>
                <h1 style={{ margin: "6px 0 0", fontWeight: 800, fontSize: 28, letterSpacing: -1.1, color: "var(--ink)", fontFamily: "var(--f)" }}>Pase de embarque</h1>
              </div>
              <button onClick={compartir} style={{ width: 40, height: 40, borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <IconShare sz={18} c="var(--navy)" />
              </button>
            </div>

            {/* Boarding pass card */}
            <div style={{ padding: "0 18px" }}>
              <div style={{ background: "var(--surface)", borderRadius: 24, overflow: "hidden", boxShadow: "0 10px 36px -10px rgba(11,49,95,0.18), 0 1px 0 rgba(0,0,0,0.04)", border: "1px solid var(--line2)" }}>

                {/* Navy band */}
                <div style={{ background: "var(--navy)", color: "white", padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <CondorMark size={28} color="white" />
                    <div>
                      <p style={{ margin: 0, fontWeight: 800, fontSize: 13, letterSpacing: 0.4, textTransform: "uppercase" }}>AFA Transportes</p>
                      <p style={{ margin: "1px 0 0", fontSize: 10.5, color: "rgba(255,255,255,0.6)", letterSpacing: 1, textTransform: "uppercase" }}>Pase digital</p>
                    </div>
                  </div>
                  <Chip color="white" bg="rgba(255,255,255,0.12)" mono>
                    <StatusDot color={miEstado === "embarcado" ? "var(--success)" : "#fbbf24"} size={6} />
                    {miEstado === "embarcado" ? "EMBARCADO" : "PENDIENTE"}
                  </Chip>
                </div>

                {/* QR */}
                <div style={{ padding: "22px 20px 8px", display: "flex", justifyContent: "center" }}>
                  {pasajero.qr_code ? (
                    <div style={{ padding: 14, background: "var(--surface)", border: "2px solid var(--navy)", borderRadius: 18 }}>
                      <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(pasajero.qr_code)}&bgcolor=ffffff&color=0b315f&qzone=2&margin=0`} alt="QR" style={{ display: "block", width: 200, height: 200 }} />
                    </div>
                  ) : (
                    <div style={{ width: 200, height: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--navy-tint)", borderRadius: 18 }}>
                      <IconQR sz={48} c="var(--navy)" />
                      <p style={{ margin: "8px 0 0", fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>QR en proceso</p>
                    </div>
                  )}
                </div>

                {pasajero.qr_code && (
                  <p style={{ textAlign: "center", margin: "6px 0 14px", fontFamily: "var(--m)", fontSize: 13, fontWeight: 600, color: "var(--ink)", letterSpacing: 3 }}>
                    AFA·{pasajero.dni || "——"}·{pasajero.qr_code.slice(-4).toUpperCase()}
                  </p>
                )}

                {/* Perforated divider */}
                <div style={{ position: "relative", height: 20, margin: "0 -1px", display: "flex", alignItems: "center" }}>
                  <div style={{ position: "absolute", left: -9, top: "50%", transform: "translateY(-50%)", width: 18, height: 18, borderRadius: "50%", background: "var(--paper)", zIndex: 1 }} />
                  <div style={{ position: "absolute", right: -9, top: "50%", transform: "translateY(-50%)", width: 18, height: 18, borderRadius: "50%", background: "var(--paper)", zIndex: 1 }} />
                  <div style={{ flex: 1, borderTop: "1.5px dashed var(--line)", margin: "0 14px" }} />
                </div>

                {/* Pass fields grid */}
                <div style={{ padding: "14px 20px 18px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12, rowGap: 14 }}>
                    {[
                      { label: "Pasajero", value: pasajero.nombre, mono: false },
                      { label: "Empresa", value: pasajero.empresa || "—", mono: false },
                      { label: "DNI", value: pasajero.dni || "—", mono: true },
                      { label: "Fecha", value: getFechaLocal(), mono: false },
                      { label: "Paradero", value: miParada?.nombre || "—", mono: false },
                      { label: "Hora", value: miParada?.hora_estimada || "—", mono: true },
                      { label: "Origen", value: (miParada?.reserva as any)?.origen || "—", mono: false },
                      { label: "Destino", value: (miParada?.reserva as any)?.destino || "—", mono: false },
                    ].map((f, i) => (
                      <div key={i} style={{ minWidth: 0 }}>
                        <Eyebrow>{f.label}</Eyebrow>
                        <p style={{ margin: "4px 0 0", fontFamily: f.mono ? "var(--m)" : "var(--f)", fontWeight: 700, fontSize: 13, color: "var(--ink)", letterSpacing: f.mono ? 0.3 : -0.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.value}</p>
                      </div>
                    ))}
                    {/* Bus row */}
                    <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--line2)", paddingTop: 12, marginTop: 2 }}>
                      <div>
                        <Eyebrow>Bus · placa</Eyebrow>
                        <p style={{ margin: "4px 0 0", fontFamily: "var(--m)", fontWeight: 700, fontSize: 18, color: "var(--ink)", letterSpacing: 0.5 }}>{vehiculo?.placa || "—"}</p>
                      </div>
                      <Chip color={miEstado === "embarcado" ? "var(--success)" : "var(--warn)"} bg={miEstado === "embarcado" ? "var(--success-tint)" : "var(--warn-tint)"}>
                        {miEstado === "embarcado" ? <><IconCheck sz={12} c="var(--success)" sw={3} /> Embarque confirmado</> : <><IconClock sz={12} c="var(--warn)" /> Esperando escaneo</>}
                      </Chip>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Helper card */}
            <div style={{ padding: "14px 18px 0" }}>
              <div style={{ background: "var(--navy-tint)", borderRadius: 14, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--line2)" }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: "var(--navy)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <IconQR sz={16} c="white" />
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink2)", letterSpacing: -0.1, lineHeight: 1.4 }}>Muestra este código al conductor para confirmar tu embarque. Brillo al máximo.</p>
              </div>
            </div>

            {/* Navigation shortcut */}
            {miParada && (
              <div style={{ padding: "12px 18px 0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button onClick={() => setMostrarNavModal(true)} style={{ padding: "12px 14px", borderRadius: 14, background: "var(--navy)", color: "white", border: "none", cursor: "pointer", fontFamily: "var(--f)", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <IconNav sz={16} c="white" /> Llegar
                </button>
                <button onClick={() => setMostrarParadasModal(true)} style={{ padding: "12px 14px", borderRadius: 14, background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", cursor: "pointer", fontFamily: "var(--f)", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <IconRoute sz={16} c="var(--navy)" /> Paradas
                </button>
              </div>
            )}
            <div style={{ height: 16 }} />
            </div>{/* /afa-scroll-inner */}
          </div>
        )}

        {/* ══════════ TAB PERFIL ══════════ */}
        {tab === "perfil" && (
          <div className="afa-scroll">
            <div className="afa-scroll-inner">
            <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadFoto(f); e.target.value = ""; }} />

            {/* Title */}
            <div style={{ padding: "16px 22px 12px" }}>
              <Eyebrow>Cuenta</Eyebrow>
              <h1 style={{ margin: "6px 0 0", fontWeight: 800, fontSize: 28, letterSpacing: -1.1, color: "var(--ink)", fontFamily: "var(--f)" }}>Perfil</h1>
            </div>

            {/* Navy identity card */}
            <div style={{ padding: "0 18px" }}>
              <div style={{ background: "var(--navy)", borderRadius: 22, padding: 20, color: "white", position: "relative", overflow: "hidden", boxShadow: "0 12px 30px -12px rgba(11,49,95,0.5)" }}>
                {/* Condor watermark */}
                <div style={{ position: "absolute", right: -20, bottom: -10, opacity: 0.08, pointerEvents: "none" }}>
                  <CondorMark size={180} color="white" />
                </div>
                {/* Avatar + info */}
                <div style={{ display: "flex", alignItems: "center", gap: 14, position: "relative" }}>
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <div style={{ width: 56, height: 56, borderRadius: 18, background: "rgba(255,255,255,0.16)", border: "1px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, overflow: "hidden" }}>
                      {pasajero.foto_url ? <img src={`${pasajero.foto_url}?t=${Date.now()}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : ini(pasajero.nombre)}
                      {uploading && <div style={{ position: "absolute", inset: 0, background: "rgba(11,49,95,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}><div className="afa-foto-spin" /></div>}
                    </div>
                    {!uploading && (
                      <button onClick={() => fileInputRef.current?.click()} style={{ position: "absolute", bottom: -4, right: -4, width: 24, height: 24, borderRadius: "50%", background: "var(--blue)", border: "2px solid var(--navy)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                        <IconCamera sz={12} c="white" />
                      </button>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontWeight: 800, fontSize: 18, letterSpacing: -0.4 }}>{pasajero.nombre}</p>
                    <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "rgba(255,255,255,0.7)", letterSpacing: -0.1 }}>
                      {pasajero.empresa || "AFA Tours Peru"}{pasajero.dni ? ` · DNI ${pasajero.dni}` : ""}
                    </p>
                  </div>
                </div>
                {/* Today service strip */}
                {miParada && (
                  <div style={{ marginTop: 14, padding: "12px 14px", background: "rgba(255,255,255,0.08)", borderRadius: 14, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid rgba(255,255,255,0.1)" }}>
                    <div>
                      <p style={{ margin: 0, fontSize: 10, color: "rgba(255,255,255,0.6)", letterSpacing: 1, textTransform: "uppercase", fontWeight: 700 }}>Servicio de hoy</p>
                      <p style={{ margin: "3px 0 0", fontSize: 13, color: "white", fontWeight: 700, letterSpacing: -0.2 }}>
                        {(miParada.reserva as any)?.origen || "—"} → {(miParada.reserva as any)?.destino || "—"}
                      </p>
                    </div>
                    {miParada.hora_estimada && <Chip color="white" bg="rgba(255,255,255,0.16)" mono>{miParada.hora_estimada}</Chip>}
                  </div>
                )}
              </div>
              {fotoErr && <p style={{ margin: "8px 0 0", padding: "10px 14px", background: "var(--danger-tint)", borderRadius: 10, fontSize: 12, fontWeight: 600, color: "var(--danger)" }}>{fotoErr}</p>}
            </div>

            {/* Mi servicio list */}
            <div style={{ padding: "20px 18px 0" }}>
              <Eyebrow>Mi servicio</Eyebrow>
              <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, marginTop: 10, overflow: "hidden" }}>
                {[
                  { icon: <IconRoute sz={18} c="var(--navy)" />, label: "Ruta", value: miParada ? `${(miParada.reserva as any)?.origen || "—"} → ${(miParada.reserva as any)?.destino || "—"}` : "Sin ruta hoy" },
                  { icon: <IconPin sz={18} c="var(--navy)" />, label: "Mi paradero", value: miParada?.nombre || "—" },
                  { icon: <IconClock sz={18} c="var(--navy)" />, label: "Hora estimada", value: miParada?.hora_estimada || miParada?.reserva?.hora_servicio || "—" },
                  { icon: <IconUser sz={18} c="var(--navy)" />, label: "Conductor", value: conductor?.nombre || "—" },
                  { icon: <IconBus sz={18} c="var(--navy)" />, label: "Bus · Placa", value: vehiculo?.placa || "—" },
                ].map((it, i, arr) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: i < arr.length - 1 ? "1px solid var(--line2)" : "none" }}>
                    <div style={{ width: 32, height: 32, borderRadius: 10, background: "var(--navy-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{it.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 10.5, color: "var(--mute)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{it.label}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 14, color: "var(--ink)", fontWeight: 700, letterSpacing: -0.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.value}</p>
                    </div>
                    <IconChevronRight sz={16} c="var(--mute2)" />
                  </div>
                ))}
              </div>

              {/* GPS status */}
              {gpsPermiso !== "granted" && (
                <div style={{ marginTop: 12, background: "var(--warn-tint)", borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, border: "1px solid rgba(180,83,9,0.2)" }}>
                  <IconPin sz={18} c="var(--warn)" />
                  <p style={{ margin: 0, flex: 1, fontSize: 13, color: "var(--warn)", fontWeight: 600 }}>GPS desactivado — actívalo para calcular distancia</p>
                  <button onClick={() => void solicitarGPS(true)} style={{ background: "var(--warn)", border: "none", borderRadius: 8, padding: "6px 12px", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--f)" }}>Activar</button>
                </div>
              )}
            </div>

            {/* Soporte */}
            <div style={{ padding: "18px 18px 0" }}>
              <Eyebrow>Soporte AFA Transportes</Eyebrow>
              <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16, marginTop: 10, overflow: "hidden" }}>
                {[
                  { icon: <IconPhone sz={18} c="var(--navy)" />, label: "Central", value: "(01) 345 3707", href: "tel:013453707" },
                  { icon: <IconWhatsapp sz={18} c="var(--success)" />, label: "WhatsApp", value: "966 707 225", href: "https://wa.me/51966707225" },
                  { icon: <IconMail sz={18} c="var(--navy)" />, label: "Correo", value: "transporte@afatoursperu.com", href: "mailto:transporte@afatoursperu.com" },
                ].map((it, i, arr) => (
                  <a key={i} href={it.href} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: i < arr.length - 1 ? "1px solid var(--line2)" : "none", textDecoration: "none" }}>
                    <div style={{ width: 32, height: 32, borderRadius: 10, background: "var(--navy-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{it.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 10.5, color: "var(--mute)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{it.label}</p>
                      <p style={{ margin: "2px 0 0", fontSize: 14, color: "var(--ink)", fontWeight: 700, letterSpacing: -0.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.value}</p>
                    </div>
                    <IconChevronRight sz={16} c="var(--mute2)" />
                  </a>
                ))}
              </div>
            </div>

            {/* Logout */}
            <div style={{ padding: "16px 18px 0" }}>
              <button onClick={salir} style={{ width: "100%", padding: "14px 16px", borderRadius: 14, background: "var(--surface)", border: "1px solid var(--line)", color: "var(--danger)", fontWeight: 700, fontSize: 14, fontFamily: "var(--f)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <IconLogout sz={17} c="var(--danger)" /> Cerrar sesión
              </button>
              <p style={{ textAlign: "center", margin: "14px 0 0", fontSize: 11, color: "var(--mute2)", letterSpacing: 0.3 }}>AFA Transportes · Lima, Perú</p>
            </div>
            <div style={{ height: 8 }} />
            </div>{/* /afa-scroll-inner */}
          </div>
        )}

        {/* ── BOTTOM NAV ── */}
        <nav className="afa-nav">
          {([
            { id: "ruta" as Tab, lbl: "Mi ruta",  Icon: IconMap,  badge: alerta5min && !alertaDismiss && miEstado !== "embarcado" },
            { id: "qr"   as Tab, lbl: "Pase",      Icon: IconQR,   badge: false },
            { id: "perfil" as Tab, lbl: "Perfil",  Icon: IconUser, badge: gpsPermiso === "denied" },
          ]).map(t => {
            const on = tab === t.id;
            return (
              <button key={t.id} className={`afa-tab${on ? " active" : ""}`} onClick={() => setTab(t.id)}>
                {on && <div className="afa-tab-bar" />}
                <div style={{ position: "relative" }}>
                  <t.Icon sz={22} c={on ? "var(--navy)" : "var(--mute2)"} />
                  {t.badge && <div className="afa-tab-badge" />}
                </div>
                <span className="afa-tab-lbl">{t.lbl}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </>
  );
}