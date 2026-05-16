"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
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
function dist(lat1:number,lng1:number,lat2:number,lng2:number): number {
  const R=6371000,φ1=lat1*Math.PI/180,φ2=lat2*Math.PI/180,Δφ=(lat2-lat1)*Math.PI/180,Δλ=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(Δφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function calcETA(d:number,v:number): number { return Math.ceil((d/1000)/(v>5?v:25)*60); }
function fmtETA(m:number): string { if(m<=0) return "¡Llegando!"; if(m<60) return `${m} min`; return `${Math.floor(m/60)}h ${m%60}m`; }
function fmtDist(m:number): string { return m>=1000?`${(m/1000).toFixed(1)} km`:`${Math.round(m)} m`; }
function ini(n:string): string { return n.split(" ").slice(0,2).map(w=>w[0]).join("").toUpperCase(); }

// ─── CSS (idéntico al HTML de referencia) ────────────────────────────────────

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&family=DM+Mono:wght@400;500&display=swap');
@import url('https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.31.0/dist/tabler-icons.min.css');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
:root{
  --navy:#0B1F3A;--navy-soft:#2A4A7F;
  --sky:#3B82F6;--sky-light:#EFF6FF;--sky-mid:#BFDBFE;
  --white:#fff;--g50:#F8FAFC;--g100:#F1F5F9;--g200:#E2E8F0;
  --g300:#CBD5E1;--g400:#94A3B8;--g500:#64748B;--g600:#475569;--g800:#1E293B;
  --green:#16A34A;--gl:#DCFCE7;--gm:#86EFAC;
  --amber:#D97706;--al:#FEF3C7;
  --red:#DC2626;--rl:#FEF2F2;
  --f:'DM Sans',system-ui,sans-serif;--m:'DM Mono',monospace;
  --rsm:10px;--rmd:14px;--rlg:20px;--rxl:24px;
}
.afa-backdrop{position:fixed;inset:0;z-index:9998;background:var(--g50);}
.afa-app{position:fixed;top:0;left:50%;transform:translateX(-50%);width:100%;max-width:420px;height:100vh;height:100dvh;z-index:9999;background:var(--g50);display:flex;flex-direction:column;overflow:hidden;font-family:var(--f);}
/* HEADER */
.afa-hdr{background:var(--navy);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:30;border-bottom:1px solid rgba(255,255,255,.06);}
.afa-hdr-l{display:flex;align-items:center;gap:10px;}
.afa-av{width:38px;height:38px;border-radius:12px;background:var(--navy-soft);border:1.5px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;letter-spacing:-.5px;overflow:hidden;}
.afa-hdr-name{color:#fff;font-weight:600;font-size:14px;letter-spacing:-.2px;}
.afa-hdr-co{color:rgba(255,255,255,.45);font-size:11px;margin-top:1px;}
.afa-hdr-r{display:flex;gap:6px;align-items:center;}
.afa-hdr-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.8);cursor:pointer;font-size:18px;transition:background .15s;}
.afa-hdr-btn:hover{background:rgba(255,255,255,.14);}
.afa-boarded-pill{font-size:11px;font-weight:800;padding:4px 10px;border-radius:20px;color:var(--green);background:var(--gl);}
/* ALERT */
.afa-alert{margin:8px 14px 0;background:var(--green);border-radius:var(--rmd);padding:12px 14px;display:flex;align-items:center;gap:10px;animation:afa-slideDown .35s cubic-bezier(.34,1.56,.64,1);border:1px solid rgba(255,255,255,.15);box-shadow:0 4px 20px rgba(22,163,74,.35);}
.afa-alert-title{color:#fff;font-weight:700;font-size:14px;}
.afa-alert-sub{color:rgba(255,255,255,.8);font-size:12px;margin-top:2px;}
.afa-alert-btn{background:rgba(255,255,255,.2);border:none;border-radius:8px;padding:5px 10px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--f);flex-shrink:0;}
/* CONTENT */
.afa-content{flex:1;overflow-y:auto;overflow-x:hidden;padding-bottom:70px;-webkit-overflow-scrolling:touch;}
.afa-panel{animation:afa-fadeIn .2s ease;}
/* MAP */
.afa-map{position:relative;height:310px;background:#EAE6DF;overflow:hidden;}
.afa-map-badge{position:absolute;top:14px;left:14px;background:#fff;border-radius:var(--rsm);padding:6px 11px;display:flex;align-items:center;gap:6px;box-shadow:0 2px 12px rgba(0,0,0,.12);border:1px solid var(--g200);z-index:10;}
.afa-dot{width:7px;height:7px;border-radius:50%;animation:afa-pulseDot 1.8s ease-in-out infinite;flex-shrink:0;}
.afa-dot-g{background:var(--green);} .afa-dot-a{background:var(--amber);} .afa-dot-r{background:var(--red);}
.afa-badge-txt{font-size:12px;font-weight:600;color:var(--g800);}
.afa-center-btn{position:absolute;bottom:14px;right:14px;width:40px;height:40px;border-radius:12px;background:#fff;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.14);display:flex;align-items:center;justify-content:center;color:var(--g600);font-size:20px;border:1px solid var(--g200);transition:background .15s;z-index:10;}
.afa-center-btn:hover{background:var(--g50);}
.afa-map-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:5;}
/* ETA CARD */
.afa-eta{margin:-28px 14px 0;position:relative;z-index:10;background:#fff;border-radius:var(--rxl);padding:20px;box-shadow:0 8px 32px rgba(11,31,58,.12),0 1px 4px rgba(11,31,58,.06);border:1px solid var(--g200);}
.afa-eta-hdr{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;}
.afa-eta-lbl{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:5px;}
.afa-eta-time{font-size:52px;font-weight:800;color:var(--navy);letter-spacing:-2px;line-height:1;}
.afa-eta-time.amber{color:var(--amber);} .afa-eta-time.red{color:var(--red);}
.afa-eta-dist{font-size:12px;color:var(--g400);margin-top:5px;font-weight:500;}
.afa-eta-icon{width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0;}
/* PROGRESS */
.afa-prog-wrap{margin-bottom:16px;}
.afa-prog-track{height:5px;background:var(--g100);border-radius:3px;overflow:hidden;margin-bottom:5px;}
.afa-prog-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--green),#22C55E);transition:width 1.5s ease;}
.afa-prog-fill.amber{background:var(--amber);}
.afa-prog-labels{display:flex;justify-content:space-between;}
.afa-prog-lbl{font-size:10px;color:var(--g400);font-weight:500;}
/* STATS */
.afa-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
.afa-stat{background:var(--g50);border-radius:var(--rmd);padding:10px 13px;border:1px solid var(--g100);}
.afa-stat-lbl{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;}
.afa-stat-val{font-size:15px;font-weight:700;color:var(--navy);margin-top:4px;font-family:var(--m);}
.afa-stat-val.name{font-family:var(--f);font-size:13px;}
.afa-stat-val.green{color:var(--green);} .afa-stat-val.amber{color:var(--amber);}
/* STOP ROW */
.afa-srow{background:var(--sky-light);border-radius:var(--rmd);padding:12px 14px;display:flex;align-items:center;gap:12px;margin-bottom:14px;border:1px solid var(--sky-mid);}
.afa-srow-icon{width:38px;height:38px;border-radius:12px;background:var(--navy);display:flex;align-items:center;justify-content:center;color:#fff;font-size:17px;flex-shrink:0;}
.afa-srow-name{font-weight:700;font-size:14px;color:var(--navy);}
.afa-srow-eta{font-size:12px;color:var(--sky);margin-top:2px;font-weight:600;}
.afa-srow-addr{font-size:11px;color:var(--g400);margin-top:2px;}
/* NAV BTNS */
.afa-nav-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.afa-nav-lbl{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1px;margin:0 0 10px;}
.afa-waze{padding:13px 0;border-radius:var(--rmd);border:none;background:#33CCFF;color:#082035;font-weight:800;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;font-family:var(--f);box-shadow:0 3px 10px rgba(51,204,255,.35);transition:transform .1s;}
.afa-waze:active{transform:scale(.97);}
.afa-maps{padding:13px 0;border-radius:var(--rmd);border:1.5px solid var(--g200);background:var(--g50);color:var(--navy);font-weight:800;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;font-family:var(--f);transition:transform .1s;}
.afa-maps:active{transform:scale(.97);}
/* WAITING */
.afa-waiting{background:var(--g50);border-radius:12px;padding:14px 16px;border:1px solid var(--g100);margin-bottom:14px;}
/* SECTION LABEL */
.afa-sec-lbl{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1.2px;margin:20px 14px 10px;}
/* STOPS LIST */
.afa-stops{margin:0 14px;background:#fff;border-radius:var(--rlg);border:1px solid var(--g200);overflow:hidden;}
.afa-si{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--g100);}
.afa-si:last-child{border-bottom:none;}
.afa-si.mine{background:var(--sky-light);} .afa-si.done{opacity:.55;}
.afa-si-num{width:24px;height:24px;border-radius:50%;background:var(--g200);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--g600);flex-shrink:0;}
.afa-si-num.active{background:var(--navy);color:#fff;} .afa-si-num.done{background:var(--green);color:#fff;}
.afa-si-name{font-size:13px;font-weight:600;color:var(--g800);flex:1;}
.afa-si-name.active{color:var(--navy);font-weight:700;}
.afa-si-hr{font-size:11px;color:var(--g400);margin-top:2px;}
.afa-badge-mine{font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:var(--sky-mid);color:#1D4ED8;flex-shrink:0;}
.afa-badge-done{font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:var(--gl);color:var(--green);flex-shrink:0;}
/* CALL */
.afa-call{display:flex;align-items:center;justify-content:center;gap:8px;margin:12px 14px 0;padding:13px 0;border-radius:var(--rmd);background:#fff;border:1.5px solid var(--g200);color:var(--navy);font-weight:600;font-size:14px;text-decoration:none;font-family:var(--f);}
/* QR */
.afa-qr-card{margin:14px 14px 0;background:#fff;border-radius:var(--rxl);overflow:hidden;border:1px solid var(--g200);box-shadow:0 4px 24px rgba(11,31,58,.1);}
.afa-qr-hdr{background:var(--navy);padding:22px 24px;display:flex;flex-direction:column;align-items:center;border-bottom:1px solid rgba(255,255,255,.06);}
.afa-qr-brand{color:rgba(255,255,255,.5);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;}
.afa-qr-name{color:#fff;font-weight:800;font-size:17px;margin-top:3px;letter-spacing:-.5px;}
.afa-qr-body{padding:24px;display:flex;flex-direction:column;align-items:center;}
.afa-qr-frame{padding:14px;background:#fff;border-radius:var(--rlg);border:2.5px solid var(--navy);box-shadow:0 4px 20px rgba(11,31,58,.1);margin-bottom:16px;}
.afa-qr-hint{font-size:12px;color:var(--g400);text-align:center;margin-bottom:6px;font-weight:500;}
.afa-qr-code{font-family:var(--m);font-size:12px;color:var(--navy);font-weight:500;letter-spacing:2px;text-align:center;}
.afa-qr-div{height:1px;background:var(--g100);margin:20px 0;width:100%;}
.afa-qr-pax{display:flex;align-items:center;gap:14px;width:100%;}
.afa-qr-pav{width:52px;height:52px;border-radius:16px;background:var(--navy);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:20px;flex-shrink:0;overflow:hidden;}
.afa-qr-pname{font-size:16px;font-weight:700;color:var(--g800);letter-spacing:-.3px;}
.afa-qr-pco{font-size:13px;color:var(--g500);margin-top:2px;}
.afa-qr-pdni{font-size:12px;color:var(--g400);margin-top:2px;font-family:var(--m);}
.afa-qr-route{width:100%;background:var(--g50);border-radius:var(--rmd);padding:14px;border:1px solid var(--g200);margin-top:14px;}
.afa-qr-rlbl{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;}
.afa-qr-rline{font-size:14px;font-weight:800;color:var(--navy);margin-bottom:4px;letter-spacing:-.3px;}
.afa-qr-rrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;}
.afa-qr-rkey{font-size:12px;color:var(--g500);}
.afa-qr-rval{font-size:12px;font-weight:600;color:var(--navy);}
.afa-pill-b{display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:var(--rmd);background:var(--gl);border:1px solid var(--gm);margin:12px 0 0;width:100%;}
.afa-pill-w{display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:var(--rmd);background:var(--al);border:1px solid #FDE68A;margin:12px 0 0;width:100%;}
.afa-pill-title-b{font-weight:700;font-size:13px;color:var(--green);}
.afa-pill-sub-b{font-size:12px;margin-top:2px;color:#166534;}
.afa-pill-title-w{font-weight:700;font-size:13px;color:var(--amber);}
.afa-pill-sub-w{font-size:12px;margin-top:2px;color:#92400E;}
.afa-qr-nav{padding:20px 24px 24px;border-top:1px solid var(--g100);}
.afa-qr-nav-lbl{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;}
/* INSTRUCTIONS */
.afa-instr{margin:14px 14px 0;background:#fff;border-radius:var(--rlg);padding:18px 20px;border:1px solid var(--g200);}
.afa-instr-title{font-size:14px;font-weight:700;color:var(--navy);margin-bottom:14px;}
.afa-instr-step{display:flex;gap:12px;margin-bottom:10px;}
.afa-instr-num{width:24px;height:24px;border-radius:50%;background:var(--navy);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.afa-instr-txt{font-size:13px;color:var(--g500);line-height:1.5;padding-top:2px;}
/* PROFILE */
.afa-prof-hero{background:var(--navy);margin:14px 14px 0;border-radius:var(--rxl);padding:22px 20px;display:flex;align-items:center;gap:16px;border:1px solid rgba(255,255,255,.06);}
.afa-prof-av-wrap{position:relative;width:72px;height:72px;flex-shrink:0;}
.afa-prof-av{width:72px;height:72px;border-radius:20px;background:var(--navy-soft);border:2px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#fff;overflow:hidden;}
.afa-prof-av img{width:100%;height:100%;object-fit:cover;}
.afa-foto-btn{position:absolute;bottom:-4px;right:-4px;width:26px;height:26px;border-radius:50%;background:var(--sky);border:2.5px solid var(--navy);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .15s;z-index:2;}
.afa-foto-btn:hover{transform:scale(1.1);}
.afa-foto-btn i{font-size:13px;color:#fff;}
.afa-foto-loading{position:absolute;inset:0;border-radius:20px;background:rgba(11,31,58,.6);display:flex;align-items:center;justify-content:center;}
.afa-foto-spin{width:22px;height:22px;border:2.5px solid rgba(255,255,255,.3);border-top:2.5px solid #fff;border-radius:50%;animation:afa-spin 0.9s linear infinite;}
.afa-foto-err{margin:10px 14px 0;background:var(--rl);border:1px solid #FECACA;border-radius:10px;padding:10px 14px;font-size:12px;font-weight:600;color:var(--red);}
.afa-foto-hint{font-size:11px;color:rgba(255,255,255,.4);margin-top:4px;}
.afa-prof-name{color:#fff;font-weight:700;font-size:17px;letter-spacing:-.3px;}
.afa-prof-co{color:rgba(255,255,255,.55);font-size:13px;margin-top:3px;}
.afa-prof-dni{color:rgba(255,255,255,.35);font-size:12px;margin-top:2px;font-family:var(--m);}
.afa-info-card{margin:12px 14px 0;background:#fff;border-radius:var(--rlg);padding:18px 20px;border:1px solid var(--g200);}
.afa-info-lbl{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:14px;}
.afa-info-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--g100);}
.afa-info-row:last-child{border-bottom:none;}
.afa-info-key{font-size:13px;color:var(--g500);}
.afa-info-val{font-size:13px;font-weight:600;color:var(--navy);}
.afa-contact-card{margin:12px 14px 0;background:#fff;border-radius:var(--rlg);border:1px solid var(--g200);overflow:hidden;}
.afa-contact-hdr{padding:14px 18px 10px;font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1.2px;}
.afa-contact-item{display:flex;align-items:center;gap:12px;padding:12px 18px;border-top:1px solid var(--g100);text-decoration:none;transition:background .12s;}
.afa-contact-item:hover{background:var(--g50);}
.afa-contact-icon{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.afa-contact-icon.blue{background:var(--sky-light);color:var(--sky);}
.afa-contact-icon.green{background:var(--gl);color:var(--green);}
.afa-contact-type{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;}
.afa-contact-val{font-size:13px;font-weight:600;color:var(--navy);margin-top:2px;}
.afa-contact-arr{margin-left:auto;color:var(--g300);font-size:16px;}
.afa-logout{margin:12px 14px 0;width:calc(100% - 28px);padding:13px 0;border-radius:var(--rmd);border:1.5px solid #FECACA;background:var(--rl);color:var(--red);font-size:14px;font-weight:700;cursor:pointer;font-family:var(--f);display:flex;align-items:center;justify-content:center;gap:7px;transition:opacity .15s;}
.afa-logout:hover{opacity:.85;}
/* BOTTOM NAV */
.afa-nav{position:absolute;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--g200);display:flex;z-index:20;box-shadow:0 -4px 20px rgba(0,0,0,.07);}
.afa-tab{flex:1;border:none;background:none;cursor:pointer;padding:10px 0 8px;display:flex;flex-direction:column;align-items:center;gap:3px;position:relative;font-family:var(--f);}
.afa-tab.active::after{content:'';position:absolute;top:0;left:25%;right:25%;height:2.5px;background:var(--navy);border-radius:0 0 3px 3px;}
.afa-tab-icon{font-size:21px;color:var(--g400);position:relative;}
.afa-tab.active .afa-tab-icon{color:var(--navy);}
.afa-tab-lbl{font-size:10px;font-weight:600;color:var(--g400);letter-spacing:.2px;}
.afa-tab.active .afa-tab-lbl{color:var(--navy);}
.afa-tab-badge{position:absolute;top:-2px;right:-5px;width:8px;height:8px;border-radius:50%;background:var(--red);border:1.5px solid #fff;}
/* LOGIN */
.afa-login{position:fixed;top:0;left:50%;transform:translateX(-50%);width:100%;max-width:420px;height:100vh;height:100dvh;overflow-y:auto;z-index:9999;display:flex;flex-direction:column;background:#fff;font-family:var(--f);}
.afa-login-top{background:var(--navy);padding:56px 24px 44px;text-align:center;}
.afa-login-ico{width:72px;height:72px;background:rgba(255,255,255,.1);border-radius:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;border:1.5px solid rgba(255,255,255,.12);font-size:32px;}
.afa-login-title{color:#fff;font-weight:800;font-size:22px;margin:0;letter-spacing:-.5px;}
.afa-login-sub{color:rgba(255,255,255,.45);font-size:13px;margin:6px 0 0;font-weight:500;}
.afa-login-body{flex:1;padding:32px 24px;max-width:420px;margin:0 auto;width:100%;}
.afa-login-desc{color:var(--g500);font-size:14px;text-align:center;margin-bottom:28px;line-height:1.6;}
.afa-login-lbl{display:block;font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px;}
.afa-login-input{width:100%;padding:18px 20px;border-radius:16px;font-size:26px;font-weight:800;text-align:center;letter-spacing:6px;outline:none;color:var(--g800);margin-bottom:16px;font-family:var(--m);transition:border-color .2s;}
.afa-login-err{background:var(--rl);border:1px solid #FECACA;border-radius:12px;padding:12px 16px;margin-bottom:16px;text-align:center;color:var(--red);font-size:13px;font-weight:700;}
.afa-login-btn{width:100%;padding:16px 0;border-radius:16px;border:none;color:#fff;font-size:15px;font-weight:700;font-family:var(--f);transition:background .2s;letter-spacing:-.2px;}
.afa-features{margin-top:32px;background:var(--g50);border-radius:16px;padding:20px;border:1px solid var(--g200);}
.afa-feat-title{color:var(--navy);font-weight:700;font-size:13px;margin:0 0 12px;}
.afa-feat-row{display:flex;gap:10px;margin-bottom:8px;align-items:flex-start;}
.afa-feat-ico{font-size:15px;flex-shrink:0;}
.afa-feat-txt{color:var(--g500);font-size:13px;margin:0;line-height:1.5;}
/* SPINNER */
.afa-spin{width:30px;height:30px;border:3px solid var(--g200);border-top:3px solid var(--navy);border-radius:50%;animation:afa-spin 1s linear infinite;margin:0 auto 8px;}
/* KEYFRAMES */
@keyframes afa-spin{to{transform:rotate(360deg)}}
@keyframes afa-pulseDot{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes afa-slideDown{from{transform:translateY(-16px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes afa-fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:420px){.afa-app{max-width:100%;}}
`;

// ─── MAPA DECORATIVO REALISTA (siempre visible como base, como Uber) ──────────

function MapaCiudad({ showBus = true, showStop = true }: { showBus?: boolean; showStop?: boolean }) {
  return (
    <svg
      viewBox="0 0 420 310"
      xmlns="http://www.w3.org/2000/svg"
      style={{ position:"absolute", inset:0, width:"100%", height:"100%" }}
      preserveAspectRatio="xMidYMid slice"
    >
      {/* Fondo tierra */}
      <rect width="420" height="310" fill="#EAE6DF" />

      {/* Zonas de agua / parque */}
      <rect x="0" y="255" width="420" height="55" fill="#C8DFF0" opacity="0.6" />
      <rect x="310" y="60" width="90" height="80" rx="4" fill="#C5DFB0" opacity="0.7" />
      <rect x="170" y="170" width="55" height="45" rx="3" fill="#C5DFB0" opacity="0.6" />

      {/* ── AVENIDAS PRINCIPALES (anchas, crema) ── */}
      {/* Av horizontal principal */}
      <rect x="0" y="118" width="420" height="18" fill="#F5F1EB" />
      <line x1="0" y1="127" x2="420" y2="127" stroke="#D4C9B8" strokeWidth="0.8" strokeDasharray="8,6" />
      {/* Av horizontal secundaria */}
      <rect x="0" y="195" width="420" height="14" fill="#F5F1EB" />
      <line x1="0" y1="202" x2="420" y2="202" stroke="#D4C9B8" strokeWidth="0.8" strokeDasharray="8,6" />
      {/* Av horizontal baja */}
      <rect x="0" y="248" width="420" height="10" fill="#F5F1EB" />

      {/* Av vertical 1 */}
      <rect x="72" y="0" width="18" height="310" fill="#F5F1EB" />
      <line x1="81" y1="0" x2="81" y2="310" stroke="#D4C9B8" strokeWidth="0.8" strokeDasharray="8,6" />
      {/* Av vertical 2 */}
      <rect x="188" y="0" width="18" height="310" fill="#F5F1EB" />
      <line x1="197" y1="0" x2="197" y2="310" stroke="#D4C9B8" strokeWidth="0.8" strokeDasharray="8,6" />
      {/* Av vertical 3 */}
      <rect x="308" y="0" width="14" height="310" fill="#F5F1EB" />

      {/* ── CALLES SECUNDARIAS (delgadas) ── */}
      <line x1="0" y1="68"  x2="420" y2="68"  stroke="#E8E2D9" strokeWidth="6" />
      <line x1="0" y1="158" x2="420" y2="158" stroke="#E8E2D9" strokeWidth="5" />
      <line x1="0" y1="228" x2="420" y2="228" stroke="#E8E2D9" strokeWidth="5" />

      <line x1="140" y1="0"  x2="140" y2="310" stroke="#E8E2D9" strokeWidth="6" />
      <line x1="255" y1="0"  x2="255" y2="310" stroke="#E8E2D9" strokeWidth="5" />
      <line x1="365" y1="0"  x2="365" y2="310" stroke="#E8E2D9" strokeWidth="5" />
      <line x1="36"  y1="0"  x2="36"  y2="310" stroke="#E8E2D9" strokeWidth="5" />

      {/* ── MANZANAS (bloques grises cálidos) ── */}
      {/* Fila 1 */}
      <rect x="38"  y="2"   width="32" height="64" rx="3" fill="#DDD8D1" />
      <rect x="92"  y="2"   width="44" height="64" rx="3" fill="#DDD8D1" />
      <rect x="142" y="2"   width="44" height="64" rx="3" fill="#DDD8D1" />
      <rect x="208" y="2"   width="44" height="64" rx="3" fill="#DDD8D1" />
      <rect x="257" y="2"   width="48" height="64" rx="3" fill="#DDD8D1" />
      <rect x="322" y="2"   width="40" height="64" rx="3" fill="#C5DFB0" /> {/* parque */}

      {/* Fila 2 */}
      <rect x="2"   y="70"  width="68" height="46" rx="3" fill="#DDD8D1" />
      <rect x="92"  y="70"  width="44" height="46" rx="3" fill="#DDD8D1" />
      <rect x="142" y="70"  width="44" height="46" rx="3" fill="#DDD8D1" />
      <rect x="208" y="70"  width="44" height="46" rx="3" fill="#DDD8D1" />
      <rect x="257" y="70"  width="48" height="46" rx="3" fill="#DDD8D1" />
      <rect x="322" y="70"  width="40" height="46" rx="3" fill="#C5DFB0" />

      {/* Fila 3 */}
      <rect x="2"   y="138" width="68" height="55" rx="3" fill="#DDD8D1" />
      <rect x="92"  y="138" width="44" height="55" rx="3" fill="#DDD8D1" />
      <rect x="142" y="138" width="44" height="30" rx="3" fill="#DDD8D1" />
      <rect x="172" y="172" width="12" height="21" rx="2" fill="#C5DFB0" />
      <rect x="208" y="138" width="44" height="55" rx="3" fill="#DDD8D1" />
      <rect x="257" y="138" width="48" height="55" rx="3" fill="#DDD8D1" />
      <rect x="322" y="138" width="40" height="55" rx="3" fill="#DDD8D1" />

      {/* Fila 4 */}
      <rect x="2"   y="210" width="68" height="36" rx="3" fill="#DDD8D1" />
      <rect x="92"  y="210" width="44" height="36" rx="3" fill="#DDD8D1" />
      <rect x="142" y="210" width="44" height="36" rx="3" fill="#DDD8D1" />
      <rect x="208" y="210" width="44" height="36" rx="3" fill="#DDD8D1" />
      <rect x="257" y="210" width="48" height="36" rx="3" fill="#DDD8D1" />
      <rect x="322" y="210" width="40" height="36" rx="3" fill="#DDD8D1" />

      {/* ── ETIQUETAS DE CALLES (tenues) ── */}
      <text x="10"  y="116" fontSize="7" fill="#B0A898" fontFamily="sans-serif">Av. Arequipa</text>
      <text x="10"  y="193" fontSize="7" fill="#B0A898" fontFamily="sans-serif">Av. Javier Prado</text>
      <text x="75"  y="112" fontSize="7" fill="#B0A898" fontFamily="sans-serif" transform="rotate(-90,75,100)">Av. La Marina</text>
      <text x="192" y="112" fontSize="7" fill="#B0A898" fontFamily="sans-serif" transform="rotate(-90,192,98)">Av. Brasil</text>

      {/* ── RUTA DEL BUS (línea azul punteada) ── */}
      <defs>
        <marker id="arrow-map" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0.5 L5,3 L0,5.5 Z" fill="#3B82F6" opacity="0.9"/>
        </marker>
      </defs>
      <polyline
        points="30,285 30,248 81,248 81,136 197,136 197,127 315,127 315,68 380,68"
        fill="none"
        stroke="#3B82F6"
        strokeWidth="3"
        strokeDasharray="7,5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.75"
        markerEnd="url(#arrow-map)"
      />

      {/* ── PARADA (anillo + punto azul) ── */}
      {showStop && (
        <>
          <circle cx="315" cy="68" r="14" fill="white" stroke="#3B82F6" strokeWidth="2.5" opacity="0.95" />
          <circle cx="315" cy="68" r="5"  fill="#3B82F6" />
          {/* Ripple animado */}
          <circle cx="315" cy="68" r="14" fill="none" stroke="#3B82F6" strokeWidth="1.5" opacity="0">
            <animate attributeName="r"       from="14" to="26" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" from="0.5" to="0" dur="2s" repeatCount="indefinite" />
          </circle>
        </>
      )}

      {/* ── BUS MARKER ── */}
      {showBus && (
        <>
          <circle cx="30" cy="275" r="18" fill="#0B1F3A" stroke="white" strokeWidth="2.5">
            <animateTransform attributeName="transform" type="translate" values="0,0;0,-4;0,0" dur="2.5s" repeatCount="indefinite" />
          </circle>
          {/* icono bus SVG dentro del círculo */}
          <g transform="translate(30,275)" style={{ pointerEvents:"none" }}>
            <animateTransform attributeName="transform" type="translate" values="30,275;30,271;30,275" dur="2.5s" repeatCount="indefinite" />
            <rect x="-9" y="-7" width="18" height="12" rx="2.5" fill="white" />
            <rect x="-7" y="-5" width="6" height="4" rx="1" fill="#0B1F3A" />
            <rect x="1"  y="-5" width="6" height="4" rx="1" fill="#0B1F3A" />
            <circle cx="-5" cy="5.5" r="2"   fill="white" />
            <circle cx="5"  cy="5.5" r="2"   fill="white" />
            <rect x="-9" y="3" width="18" height="2" rx="0" fill="white" />
          </g>
        </>
      )}
    </svg>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function AppPasajero() {

  const [initing,       setIniting]       = useState(true);
  const [pasajero,      setPasajero]      = useState<Pasajero | null>(null);
  const [tab,           setTab]           = useState<Tab>("ruta");
  const [dniInput,      setDniInput]      = useState("");
  const [loginErr,      setLoginErr]      = useState("");
  const [loginLoad,     setLoginLoad]     = useState(false);
  const [miParada,      setMiParada]      = useState<(Parada & { reserva: Reserva }) | null>(null);
  const [vehiculo,      setVehiculo]      = useState<Vehiculo | null>(null);
  const [conductor,     setConductor]     = useState<Conductor | null>(null);
  const [busPosicion,   setBusPosicion]   = useState<UbicacionBus | null>(null);
  const [etaMin,        setEtaMin]        = useState<number | null>(null);
  const [distM,         setDistM]         = useState<number | null>(null);
  const [estadoBus,     setEstadoBus]     = useState<EstadoBus>("no_iniciado");
  const [miEstado,      setMiEstado]      = useState("esperando");
  const [rutaParadas,   setRutaParadas]   = useState<Parada[]>([]);
  const [alerta5min,    setAlerta5min]    = useState(false);
  const [alertaDismiss, setAlertaDismiss] = useState(false);
  const [copiado,       setCopiado]       = useState(false);
  const [uploading,     setUploading]     = useState(false);
  const [fotoErr,       setFotoErr]       = useState("");
  const alertaRef    = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const busMarker    = useRef<mapboxgl.Marker | null>(null);
  const paradaMk     = useRef<mapboxgl.Marker | null>(null);
  const [mapListo,   setMapListo]         = useState(false);

  useEffect(() => {
    const saved = loadSession();
    if (saved) { setPasajero(saved); cargarMiRuta(saved.id); }
    setIniting(false);
  }, []);

  // Mapbox init
  useEffect(() => {
    if (!mapContainer.current || map.current || !pasajero) return;
    map.current = new mapboxgl.Map({ container: mapContainer.current, style: "mapbox://styles/mapbox/light-v11", center: [-77.0428,-12.0464], zoom: 13 });
    map.current.addControl(new mapboxgl.NavigationControl({ showCompass:false }), "top-right");
    map.current.on("load", () => setMapListo(true));
    return () => { map.current?.remove(); map.current = null; };
  }, [pasajero]);

  // Bus marker + ETA
  useEffect(() => {
    if (!mapListo || !map.current || !busPosicion) return;
    if (busMarker.current) {
      busMarker.current.setLngLat([Number(busPosicion.lng), Number(busPosicion.lat)]);
    } else {
      const el = document.createElement("div");
      el.className = "afa-bus-mk";
      el.innerHTML = `<i class="ti ti-bus" style="font-size:22px;color:white;"></i>`;
      busMarker.current = new mapboxgl.Marker({ element: el })
        .setLngLat([Number(busPosicion.lng), Number(busPosicion.lat)])
        .setPopup(new mapboxgl.Popup({ offset:30 }).setHTML(
          `<div style="font-family:'DM Sans',sans-serif;padding:4px">
            <p style="font-weight:800;color:#0B1F3A;margin:0 0 4px">${vehiculo?.placa||"Bus AFA"}</p>
            <p style="color:#555;font-size:12px;margin:0">🚀 ${busPosicion.velocidad} km/h</p>
            ${conductor?`<p style="color:#555;font-size:12px;margin:4px 0 0">👤 ${conductor.nombre}</p>`:""}
          </div>`))
        .addTo(map.current!);
    }
    if (miParada?.lat && miParada?.lng) {
      const d   = dist(Number(busPosicion.lat), Number(busPosicion.lng), Number(miParada.lat), Number(miParada.lng));
      const eta = calcETA(d, busPosicion.velocidad);
      setDistM(d); setEtaMin(eta);
      if (eta<=5 && !alertaRef.current && miEstado!=="embarcado") {
        alertaRef.current=true; setAlerta5min(true); setAlertaDismiss(false);
        if ("vibrate" in navigator) navigator.vibrate([300,100,300]);
      }
      const ago = (Date.now()-new Date(busPosicion.timestamp).getTime())/60000;
      if      (ago>5)                          setEstadoBus("sin_señal");
      else if (busPosicion.estado==="finalizado") setEstadoBus("finalizado");
      else if (busPosicion.velocidad<3)        setEstadoBus("retrasado");
      else                                     setEstadoBus("en_camino");
      const b = new mapboxgl.LngLatBounds();
      b.extend([Number(busPosicion.lng), Number(busPosicion.lat)]);
      b.extend([Number(miParada.lng), Number(miParada.lat)]);
      map.current?.fitBounds(b, { padding:80, maxZoom:15, duration:1500 });
    }
  }, [busPosicion, mapListo, miParada, vehiculo, conductor, miEstado]);

  // Parada marker
  useEffect(() => {
    if (!mapListo || !map.current || !miParada?.lat || paradaMk.current) return;
    const el = document.createElement("div");
    el.className = "afa-stop-mk";
    const pulse = document.createElement("div");
    pulse.className = "afa-pulse";
    el.appendChild(pulse);
    const ico = document.createElement("i");
    ico.className = "ti ti-map-pin-filled";
    ico.style.fontSize = "17px";
    el.appendChild(ico);
    paradaMk.current = new mapboxgl.Marker({ element: el })
      .setLngLat([Number(miParada.lng), Number(miParada.lat)])
      .setPopup(new mapboxgl.Popup({ offset:30 }).setHTML(
        `<div style="font-family:'DM Sans',sans-serif;padding:4px">
          <p style="font-weight:800;color:#0B1F3A;margin:0 0 4px">Tu paradero</p>
          <p style="color:#555;font-size:12px;margin:0">${miParada.nombre}</p>
          ${miParada.hora_estimada?`<p style="color:#555;font-size:11px;margin:4px 0 0">🕐 ${miParada.hora_estimada}</p>`:""}
        </div>`))
      .addTo(map.current!);
    map.current.flyTo({ center:[Number(miParada.lng), Number(miParada.lat)], zoom:14, duration:1500 });
  }, [miParada, mapListo]);

  // Línea ruta
  useEffect(() => {
    if (!mapListo || !map.current || rutaParadas.length<2) return;
    const coords = rutaParadas.filter(p=>p.lat&&p.lng).map(p=>[Number(p.lng),Number(p.lat)]);
    if (coords.length<2) return;
    if (map.current.getSource("ruta")) {
      (map.current.getSource("ruta") as mapboxgl.GeoJSONSource).setData({ type:"Feature", properties:{}, geometry:{type:"LineString",coordinates:coords} });
    } else {
      map.current.addSource("ruta", { type:"geojson", data:{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:coords}} });
      map.current.addLayer({ id:"ruta-line", type:"line", source:"ruta", layout:{"line-join":"round","line-cap":"round"}, paint:{"line-color":"#3B82F6","line-width":3,"line-dasharray":[2,2],"line-opacity":0.7} });
    }
  }, [rutaParadas, mapListo]);

  // Realtime GPS
  useEffect(() => {
    if (!miParada?.reserva?.vehiculo_id) return;
    const vid = miParada.reserva.vehiculo_id;
    const ch = supabase.channel(`bus-pax-${vid}`)
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"ubicaciones_gps", filter:`vehiculo_id=eq.${vid}` }, p => setBusPosicion(p.new as UbicacionBus))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [miParada]);

  // ── FUNCIONES ───────────────────────────────────────────────────────────────

  async function login() {
    if (dniInput.length<7) { setLoginErr("Ingresa tu DNI completo"); return; }
    setLoginErr(""); setLoginLoad(true);
    const { data } = await supabase.from("pasajeros").select("*").eq("dni", dniInput.trim()).single();
    if (!data) { setLoginErr("DNI no registrado. Contacta a tu empresa o a AFA Tours."); setLoginLoad(false); return; }
    saveSession(data); setPasajero(data); await cargarMiRuta(data.id); setLoginLoad(false);
  }

  const cargarMiRuta = useCallback(async (pid: number) => {
    const hoy = getFechaLocal();
    const { data: pp } = await supabase.from("pasajeros_parada").select(`*, parada:paradas(*, reserva:reservas(*))`).eq("pasajero_id", pid);
    if (!pp?.length) return;
    const hoyPP = pp.filter((x: any) => x.parada?.reserva?.fecha_servicio===hoy);
    let miPP: any = hoyPP.length>0 ? hoyPP[0] : pp.filter((x:any)=>x.parada?.reserva?.fecha_servicio>=hoy).sort((a:any,b:any)=>new Date(a.parada?.reserva?.fecha_servicio||0).getTime()-new Date(b.parada?.reserva?.fecha_servicio||0).getTime())[0] || pp[0];
    if (!miPP?.parada) return;
    setMiParada(miPP.parada); setMiEstado(miPP.estado||"esperando");
    const rId = miPP.parada?.reserva_id;
    if (!rId) return;
    const { data: ps } = await supabase.from("paradas").select("*").eq("reserva_id",rId).order("orden");
    setRutaParadas(ps||[]);
    const vId = miPP.parada?.reserva?.vehiculo_id;
    if (vId) {
      const [vR, uR] = await Promise.all([
        supabase.from("vehiculos").select("id,placa,categoria").eq("id",vId).single(),
        supabase.from("ubicaciones_gps").select("*").eq("vehiculo_id",vId).order("created_at",{ascending:false}).limit(1),
      ]);
      if (vR.data) setVehiculo(vR.data);
      if (uR.data?.[0]) setBusPosicion(uR.data[0]);
      const { data: uGPS } = await supabase.from("ubicaciones_gps").select("conductor_id").eq("vehiculo_id",vId).order("created_at",{ascending:false}).limit(1);
      if (uGPS?.[0]?.conductor_id) {
        const { data: cond } = await supabase.from("conductores").select("id,nombre,telefono").eq("id",uGPS[0].conductor_id).single();
        if (cond) setConductor(cond);
      }
    }
  }, []);

  function abrirWaze() {
    if (!miParada) return;
    window.open(miParada.lat&&miParada.lng
      ? `https://waze.com/ul?ll=${miParada.lat},${miParada.lng}&navigate=yes&zoom=17`
      : `https://waze.com/ul?q=${encodeURIComponent((miParada.direccion||miParada.nombre)+", Lima, Peru")}&navigate=yes`,"_blank");
  }
  function abrirMaps() {
    if (!miParada) return;
    const dest = miParada.lat&&miParada.lng ? `${miParada.lat},${miParada.lng}` : encodeURIComponent((miParada.direccion||miParada.nombre)+", Lima, Peru");
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=walking`,"_blank");
  }
  function centrarMapa() {
    if (!map.current) return;
    if (busPosicion&&miParada?.lat&&miParada?.lng) {
      const b = new mapboxgl.LngLatBounds();
      b.extend([Number(busPosicion.lng),Number(busPosicion.lat)]);
      b.extend([Number(miParada.lng),Number(miParada.lat)]);
      map.current.fitBounds(b,{padding:80,maxZoom:15,duration:1000});
    } else if (miParada?.lat&&miParada?.lng) {
      map.current.flyTo({center:[Number(miParada.lng),Number(miParada.lat)],zoom:15,duration:1000});
    }
  }
  async function compartir() {
    const txt = `🚌 Seguimiento en tiempo real · AFA Tours\n📍 Mi paradero: ${miParada?.nombre||""}\n🕐 Hora estimada: ${miParada?.hora_estimada||"—"}\n\n${window.location.href}`;
    try { if (navigator.share) await navigator.share({title:"Mi bus AFA Tours",text:txt}); else { await navigator.clipboard.writeText(txt); setCopiado(true); setTimeout(()=>setCopiado(false),3000); } } catch { /* noop */ }
  }
  async function uploadFoto(file: File) {
    if (!pasajero) return;
    setFotoErr("");
    setUploading(true);
    try {
      // Redimensionar imagen en canvas antes de subir (máx 800px, calidad 0.85)
      const bitmap = await createImageBitmap(file);
      const MAX = 800;
      const ratio = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
      const w = Math.round(bitmap.width * ratio);
      const h = Math.round(bitmap.height * ratio);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise<Blob>((res) => canvas.toBlob(b => res(b!), "image/jpeg", 0.85));

      const path = `${pasajero.id}/foto_${Date.now()}.jpg`;

      // Subir a Supabase Storage bucket "pasajeros-fotos"
      const { error: upErr } = await supabase.storage
        .from("pasajeros-fotos")
        .upload(path, blob, { upsert: true, contentType: "image/jpeg" });
      if (upErr) throw upErr;

      const { data: { publicUrl } } = supabase.storage
        .from("pasajeros-fotos")
        .getPublicUrl(path);

      // Actualizar tabla pasajeros
      const { error: dbErr } = await supabase
        .from("pasajeros")
        .update({ foto_url: publicUrl })
        .eq("id", pasajero.id);
      if (dbErr) throw dbErr;

      // Actualizar estado local + sesión
      const updated = { ...pasajero, foto_url: publicUrl };
      setPasajero(updated);
      saveSession(updated);
    } catch (e: any) {
      setFotoErr(e?.message || "Error al subir la foto. Intenta nuevamente.");
    } finally {
      setUploading(false);
    }
  }

  function salir() {
    clearSession(); setPasajero(null); setMiParada(null); setBusPosicion(null); setRutaParadas([]); setVehiculo(null); setConductor(null);
    alertaRef.current=false; setAlerta5min(false); setTab("ruta");
  }

  // Derivados
  const cfgMap: Record<EstadoBus,{dot:string;txt:string;iconCls:string;iconBg:string;iconColor:string}> = {
    no_iniciado: {dot:"afa-dot",        txt:"Esperando inicio",    iconCls:"ti-clock",         iconBg:"var(--g100)",       iconColor:"#0B1F3A"},
    en_camino:   {dot:"afa-dot afa-dot-g", txt:"En camino",          iconCls:"ti-bus",           iconBg:"var(--gl)",         iconColor:"#16A34A"},
    retrasado:   {dot:"afa-dot afa-dot-a", txt:"Retrasado",          iconCls:"ti-clock-hour-4",  iconBg:"var(--al)",         iconColor:"#D97706"},
    finalizado:  {dot:"afa-dot",        txt:"Servicio finalizado", iconCls:"ti-circle-check",  iconBg:"var(--g100)",       iconColor:"#0B1F3A"},
    sin_señal:   {dot:"afa-dot afa-dot-r", txt:"Sin señal GPS",      iconCls:"ti-wifi-off",      iconBg:"var(--rl)",         iconColor:"#DC2626"},
  };
  const cfg        = cfgMap[estadoBus];
  const busActivo  = busPosicion && estadoBus!=="finalizado";
  const etaExtra   = estadoBus==="retrasado"?" amber": estadoBus==="sin_señal"?" red":"";
  const pct        = distM!==null ? Math.max(0,Math.min(100,100-(distM/5000)*100)) : 0;

  // ── LOADING ─────────────────────────────────────────────────────────────────
  if (initing) return (
    <>
      <style>{CSS}</style>
      <div className="afa-backdrop" />
      <div style={{position:'fixed',top:0,left:'50%',transform:'translateX(-50%)',width:'100%',maxWidth:420,height:'100vh',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',background:'#0B1F3A'}}>
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
        <div className="afa-login-top">
          <div className="afa-login-ico"><i className="ti ti-bus" style={{color:"white",fontSize:32}} /></div>
          <h1 className="afa-login-title">AFA Tours Peru</h1>
          <p className="afa-login-sub">Seguimiento de Ruta · Portal del Pasajero</p>
        </div>
        <div className="afa-login-body">
          <p className="afa-login-desc">Ingresa tu DNI para ver tu bus en tiempo real y tu código de embarque</p>
          <label className="afa-login-lbl">Número de DNI</label>
          <input type="tel" inputMode="numeric" maxLength={8} value={dniInput}
            onChange={e=>{setDniInput(e.target.value.replace(/\D/g,"").slice(0,8));setLoginErr("");}}
            onKeyDown={e=>e.key==="Enter"&&login()} placeholder="12345678"
            className="afa-login-input" style={{border:`2px solid ${dniInput.length>=7?"#0B1F3A":"#E2E8F0"}`}} />
          {loginErr && <div className="afa-login-err">⚠️ {loginErr}</div>}
          <button onClick={login} disabled={loginLoad||dniInput.length<7} className="afa-login-btn"
            style={{background:dniInput.length>=7?"#0B1F3A":"#E2E8F0",cursor:dniInput.length>=7?"pointer":"not-allowed"}}>
            {loginLoad?"Buscando…":"Ver mi ruta →"}
          </button>
          <div className="afa-features">
            <p className="afa-feat-title">¿Qué puedo hacer aquí?</p>
            {[["🗺️","Ver el bus en tiempo real y el tiempo de llegada a tu paradero"],["🎫","Mostrar tu código QR para abordar el servicio"],["📍","Navegar a tu paradero con Waze o Google Maps"],["🔔","Recibir alerta cuando el bus esté a menos de 5 minutos"]].map(([ico,txt])=>(
              <div key={txt} className="afa-feat-row"><span className="afa-feat-ico">{ico}</span><p className="afa-feat-txt">{txt}</p></div>
            ))}
          </div>
          <p style={{textAlign:"center",color:"#94A3B8",fontSize:12,marginTop:24}}>
            ¿Problemas? <a href="tel:966707225" style={{color:"#0B1F3A",fontWeight:700}}>966 707 225</a>
          </p>
        </div>
      </div>
    </>
  );

  // ── APP ──────────────────────────────────────────────────────────────────────

  /* Botones de navegación reutilizables */
  const NavBtns = () => (
    <>
      <div className="afa-nav-lbl">Cómo llegar a mi paradero</div>
      <div className="afa-nav-grid">
        <button className="afa-waze" onClick={abrirWaze}>
          <svg width="18" height="18" viewBox="0 0 36 36"><ellipse cx="18" cy="16" rx="9" ry="9" fill="rgba(255,255,255,.4)"/><circle cx="14.5" cy="14.5" r="2" fill="#082035"/><circle cx="21.5" cy="14.5" r="2" fill="#082035"/><path d="M14 19 Q18 23 22 19" stroke="#082035" strokeWidth="1.8" fill="none" strokeLinecap="round"/></svg>
          Waze
        </button>
        <button className="afa-maps" onClick={abrirMaps}>
          <svg width="13" height="17" viewBox="0 0 20 26"><path d="M10 0C4.48 0 0 4.48 0 10c0 7.5 10 16 10 16s10-8.5 10-16C20 4.48 15.52 0 10 0z" fill="#EA4335"/><circle cx="10" cy="10" r="4" fill="white"/></svg>
          Google Maps
        </button>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="afa-backdrop" />
      <div className="afa-app">

        {/* ── HEADER ── */}
        <header className="afa-hdr">
          <div className="afa-hdr-l">
            <div className="afa-av">
              {pasajero.foto_url
                ? <img src={pasajero.foto_url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                : ini(pasajero.nombre)}
            </div>            <div>
              <div className="afa-hdr-name">{pasajero.nombre.split(" ").slice(0,2).join(" ")}</div>
              <div className="afa-hdr-co">{pasajero.empresa||"AFA Tours Peru"}</div>
            </div>
          </div>
          <div className="afa-hdr-r">
            {miEstado==="embarcado" && <span className="afa-boarded-pill">✓ A bordo</span>}
            <button className="afa-hdr-btn" onClick={compartir} title="Compartir">
              <i className={copiado?"ti ti-check":"ti ti-share-3"} />
            </button>
            <button className="afa-hdr-btn" onClick={salir} title="Salir">
              <i className="ti ti-door-exit" />
            </button>
          </div>
        </header>

        {/* ── ALERTA ≤5 min ── */}
        {alerta5min && !alertaDismiss && miEstado!=="embarcado" && (
          <div className="afa-alert">
            <i className="ti ti-alert-triangle" style={{color:"white",fontSize:22,flexShrink:0}} />
            <div style={{flex:1}}>
              <div className="afa-alert-title">¡Tu bus está llegando!</div>
              <div className="afa-alert-sub">Dirígete a tu paradero — {etaMin!==null?fmtETA(etaMin):"< 5 min"}</div>
            </div>
            <button className="afa-alert-btn" onClick={()=>setAlertaDismiss(true)}>OK</button>
          </div>
        )}

        {/* ── CONTENIDO ── */}
        <div className="afa-content">

          {/* ══════════ TAB RUTA ══════════ */}
          {tab==="ruta" && (
            <div className="afa-panel">

              {/* MAPA — decorativo siempre visible como base, Mapbox encima si carga */}
              <div className="afa-map">

                {/* ── BASE: mapa ciudad siempre visible (como Uber) ── */}
                <MapaCiudad
                  showBus={!busPosicion}
                  showStop={!!miParada}
                />

                {/* ── MAPBOX: se monta encima y hace fade-in cuando carga ── */}
                <div
                  ref={mapContainer}
                  style={{
                    position:"absolute", inset:0,
                    opacity: mapListo ? 1 : 0,
                    transition: "opacity 0.8s ease",
                  }}
                />

                {/* ── OVERLAY: sin ruta asignada ── */}
                {!miParada && (
                  <div className="afa-map-overlay" style={{ background:"rgba(234,230,223,0.82)" }}>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ width:56, height:56, borderRadius:16, background:"white", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px", boxShadow:"0 4px 16px rgba(0,0,0,0.12)" }}>
                        <i className="ti ti-map-off" style={{ fontSize:26, color:"#94A3B8" }} />
                      </div>
                      <p style={{ color:"#0B1F3A", fontWeight:700, fontSize:15, margin:0 }}>Sin ruta asignada hoy</p>
                      <p style={{ color:"#94A3B8", fontSize:12, margin:"6px 0 0" }}>Tu empresa aún no registró tu paradero</p>
                    </div>
                  </div>
                )}

                {/* Badge GPS */}
                {busPosicion && (
                  <div className="afa-map-badge">
                    <div className={cfg.dot} />
                    <span className="afa-badge-txt">{cfg.txt}{estadoBus==="en_camino"?` · ${busPosicion.velocidad} km/h`:""}</span>
                  </div>
                )}

                {/* Sin GPS aún: badge de espera */}
                {miParada && !busPosicion && (
                  <div className="afa-map-badge">
                    <div className="afa-dot" style={{ background:"#94A3B8" }} />
                    <span className="afa-badge-txt">Esperando inicio del recorrido</span>
                  </div>
                )}

                {/* Botón centrar */}
                <button className="afa-center-btn" onClick={centrarMapa} title="Centrar mapa">
                  <i className="ti ti-focus-2" />
                </button>
              </div>

              {/* ETA CARD */}
              {miParada && (
                <div className="afa-eta">
                  {busActivo && etaMin!==null ? (
                    <>
                      <div className="afa-eta-hdr">
                        <div>
                          <div className="afa-eta-lbl">Tiempo de llegada a tu paradero</div>
                          <div className={`afa-eta-time${etaExtra}`}>{fmtETA(etaMin)}</div>
                          {distM!==null && (
                            <div className="afa-eta-dist">
                              <i className="ti ti-ruler-2" style={{fontSize:13,verticalAlign:-2}} />{" "}
                              El bus está a <strong>{fmtDist(distM)}</strong> de tu paradero
                            </div>
                          )}
                        </div>
                        <div className="afa-eta-icon" style={{background:cfg.iconBg}}>
                          <i className={`ti ${cfg.iconCls}`} style={{fontSize:26,color:cfg.iconColor}} />
                        </div>
                      </div>
                      {distM!==null && (
                        <div className="afa-prog-wrap">
                          <div className="afa-prog-track">
                            <div className={`afa-prog-fill${estadoBus==="retrasado"?" amber":""}`} style={{width:`${pct}%`}} />
                          </div>
                          <div className="afa-prog-labels">
                            <span className="afa-prog-lbl">Lejos</span>
                            <span className="afa-prog-lbl">En tu paradero</span>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="afa-waiting">
                      <p style={{color:"#0B1F3A",fontWeight:700,fontSize:15,margin:0}}>🕐 Esperando inicio del recorrido</p>
                      <p style={{color:"#94A3B8",fontSize:12,margin:"4px 0 0"}}>El conductor aún no ha iniciado la ruta</p>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="afa-stats">
                    <div className="afa-stat">
                      <div className="afa-stat-lbl"><i className="ti ti-bus-stop" style={{fontSize:12,verticalAlign:-1}} /> Placa</div>
                      <div className="afa-stat-val">{vehiculo?.placa||"—"}</div>
                    </div>
                    <div className="afa-stat">
                      <div className="afa-stat-lbl"><i className="ti ti-user" style={{fontSize:12,verticalAlign:-1}} /> Conductor</div>
                      <div className="afa-stat-val name">{conductor?.nombre?.split(" ").slice(0,2).join(" ")||"—"}</div>
                    </div>
                    {busPosicion && (
                      <div className="afa-stat">
                        <div className="afa-stat-lbl"><i className="ti ti-gauge" style={{fontSize:12,verticalAlign:-1}} /> Velocidad</div>
                        <div className="afa-stat-val">{busPosicion.velocidad} km/h</div>
                      </div>
                    )}
                    <div className="afa-stat">
                      <div className="afa-stat-lbl"><i className="ti ti-ticket" style={{fontSize:12,verticalAlign:-1}} /> Mi estado</div>
                      <div className={`afa-stat-val name ${miEstado==="embarcado"?"green":"amber"}`}>
                        {miEstado==="embarcado"?"✅ A bordo":"⏳ Esperando"}
                      </div>
                    </div>
                  </div>

                  {/* Mi paradero */}
                  <div className="afa-srow">
                    <div className="afa-srow-icon"><i className="ti ti-map-pin" style={{fontSize:17}} /></div>
                    <div style={{flex:1}}>
                      <div className="afa-srow-name">{miParada.nombre}</div>
                      {miParada.hora_estimada && <div className="afa-srow-eta"><i className="ti ti-clock" style={{fontSize:12,verticalAlign:-1}} /> Hora estimada: {miParada.hora_estimada}</div>}
                      {miParada.direccion && <div className="afa-srow-addr">{miParada.direccion}</div>}
                    </div>
                  </div>

                  <NavBtns />
                </div>
              )}

              {/* LISTA PARADAS */}
              {rutaParadas.length>1 && (
                <>
                  <div className="afa-sec-lbl">Paradas del recorrido ({rutaParadas.length})</div>
                  <div className="afa-stops">
                    {rutaParadas.map((p,i)=>{
                      const esMia = p.id===miParada?.id;
                      const done  = p.estado==="completada";
                      return (
                        <div key={p.id} className={`afa-si${esMia?" mine":""}${done?" done":""}`}>
                          <div className={`afa-si-num${done?" done":esMia?" active":""}`}>
                            {done ? <i className="ti ti-check" style={{fontSize:12}} /> : i+1}
                          </div>
                          <div style={{flex:1}}>
                            <div className={`afa-si-name${esMia?" active":""}`}>
                              {p.nombre}
                              {esMia && <span style={{color:"#1D4ED8",fontSize:11,fontWeight:700,marginLeft:8}}>← Tu parada</span>}
                            </div>
                            {p.hora_estimada && <div className="afa-si-hr">🕐 {p.hora_estimada}</div>}
                          </div>
                          {done && <span className="afa-badge-done">Completada</span>}
                          {!done && esMia && <span className="afa-badge-mine">Aquí</span>}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {conductor?.telefono && (
                <a href={`tel:${conductor.telefono}`} className="afa-call">
                  <i className="ti ti-phone-call" style={{fontSize:17,color:"#3B82F6"}} />
                  Llamar al conductor · {conductor.telefono}
                </a>
              )}
              <div style={{height:16}} />
            </div>
          )}

          {/* ══════════ TAB QR ══════════ */}
          {tab==="qr" && (
            <div className="afa-panel">
              <div className="afa-qr-card">
                <div className="afa-qr-hdr">
                  <div className="afa-qr-brand">Identificación Digital</div>
                  <div className="afa-qr-name">AFA Tours Peru</div>
                </div>
                <div className="afa-qr-body">
                  {pasajero.qr_code ? (
                    <>
                      <div className="afa-qr-frame">
                        <img src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(pasajero.qr_code)}&bgcolor=ffffff&color=0B1F3A&qzone=2&margin=0`} alt="QR de embarque" style={{display:"block",width:220,height:220}} />
                      </div>
                      <div className="afa-qr-hint">Muestra este código al conductor</div>
                      <div className="afa-qr-code">{pasajero.qr_code.slice(0,16).toUpperCase()}</div>
                    </>
                  ) : (
                    <div style={{padding:32,textAlign:"center"}}>
                      <p style={{fontSize:36,margin:"0 0 8px"}}>⏳</p>
                      <p style={{color:"#0B1F3A",fontWeight:700,fontSize:15}}>QR en proceso</p>
                      <p style={{color:"#94A3B8",fontSize:13}}>Tu código será asignado pronto</p>
                    </div>
                  )}

                  <div className="afa-qr-div" />

                  <div className="afa-qr-pax">
                    <div className="afa-qr-pav">
                      {pasajero.foto_url ? <img src={pasajero.foto_url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} /> : ini(pasajero.nombre)}
                    </div>
                    <div>
                      <div className="afa-qr-pname">{pasajero.nombre}</div>
                      {pasajero.empresa && <div className="afa-qr-pco"><i className="ti ti-building" style={{fontSize:13,verticalAlign:-2}} /> {pasajero.empresa}</div>}
                      {pasajero.dni && <div className="afa-qr-pdni">DNI: {pasajero.dni}</div>}
                    </div>
                  </div>

                  {miParada?.reserva && (
                    <div className="afa-qr-route">
                      <div className="afa-qr-rlbl">Ruta asignada</div>
                      <div className="afa-qr-rline">{miParada.reserva.origen} → {miParada.reserva.destino}</div>
                      <div className="afa-qr-rrow">
                        <span className="afa-qr-rkey"><i className="ti ti-map-pin" style={{fontSize:13,verticalAlign:-2}} /> Paradero</span>
                        <span className="afa-qr-rval">{miParada.nombre}</span>
                      </div>
                      {miParada.hora_estimada && (
                        <div className="afa-qr-rrow">
                          <span className="afa-qr-rkey"><i className="ti ti-clock" style={{fontSize:13,verticalAlign:-2}} /> Hora</span>
                          <span className="afa-qr-rval">{miParada.hora_estimada}</span>
                        </div>
                      )}
                      {miParada.reserva.fecha_servicio && (
                        <div className="afa-qr-rrow" style={{marginBottom:0}}>
                          <span className="afa-qr-rkey"><i className="ti ti-calendar" style={{fontSize:13,verticalAlign:-2}} /> Fecha</span>
                          <span className="afa-qr-rval">{new Date(miParada.reserva.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{weekday:"long",day:"numeric",month:"long"})}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className={miEstado==="embarcado"?"afa-pill-b":"afa-pill-w"}>
                    <i className={`ti ${miEstado==="embarcado"?"ti-circle-check":"ti-clock-hour-4"}`} style={{fontSize:20,color:miEstado==="embarcado"?"#16A34A":"#D97706",flexShrink:0}} />
                    <div>
                      <div className={miEstado==="embarcado"?"afa-pill-title-b":"afa-pill-title-w"}>
                        {miEstado==="embarcado"?"Embarque confirmado":"Esperando embarque"}
                      </div>
                      <div className={miEstado==="embarcado"?"afa-pill-sub-b":"afa-pill-sub-w"}>
                        {miEstado==="embarcado"?"El conductor escaneó tu QR exitosamente":"Muestra este QR cuando el bus llegue"}
                      </div>
                    </div>
                  </div>
                </div>

                {miParada && (
                  <div className="afa-qr-nav">
                    <div className="afa-qr-nav-lbl">Navegar a mi paradero</div>
                    <div className="afa-nav-grid">
                      <button className="afa-waze" onClick={abrirWaze}>
                        <svg width="16" height="16" viewBox="0 0 36 36"><ellipse cx="18" cy="16" rx="9" ry="9" fill="rgba(255,255,255,.4)"/><circle cx="14.5" cy="14.5" r="2" fill="#082035"/><circle cx="21.5" cy="14.5" r="2" fill="#082035"/><path d="M14 19 Q18 23 22 19" stroke="#082035" strokeWidth="1.8" fill="none" strokeLinecap="round"/></svg>
                        Waze
                      </button>
                      <button className="afa-maps" onClick={abrirMaps}>
                        <svg width="12" height="16" viewBox="0 0 20 26"><path d="M10 0C4.48 0 0 4.48 0 10c0 7.5 10 16 10 16s10-8.5 10-16C20 4.48 15.52 0 10 0z" fill="#EA4335"/><circle cx="10" cy="10" r="4" fill="white"/></svg>
                        Maps
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="afa-instr">
                <div className="afa-instr-title">¿Cómo usar mi código QR?</div>
                {["Espera tu bus en el paradero asignado a la hora indicada.","Cuando llegue el bus, muestra esta pantalla al conductor.","El conductor escanea tu código para confirmar el embarque.","Recibirás confirmación aquí y en la tab «Mi Ruta»."].map((txt,i)=>(
                  <div key={i} className="afa-instr-step">
                    <div className="afa-instr-num">{i+1}</div>
                    <div className="afa-instr-txt">{txt}</div>
                  </div>
                ))}
              </div>
              <div style={{height:16}} />
            </div>
          )}

          {/* ══════════ TAB PERFIL ══════════ */}
          {tab==="perfil" && (
            <div className="afa-panel">

              {/* Input oculto: abre cámara o galería según el dispositivo */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display:"none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadFoto(f); e.target.value=""; }}
              />

              <div className="afa-prof-hero">
                {/* Avatar con botón cámara superpuesto */}
                <div className="afa-prof-av-wrap">
                  <div className="afa-prof-av">
                    {pasajero.foto_url
                      ? <img src={`${pasajero.foto_url}?t=${Date.now()}`} alt={pasajero.nombre} />
                      : ini(pasajero.nombre)}
                    {uploading && (
                      <div className="afa-foto-loading">
                        <div className="afa-foto-spin" />
                      </div>
                    )}
                  </div>
                  {!uploading && (
                    <button
                      className="afa-foto-btn"
                      onClick={() => fileInputRef.current?.click()}
                      title="Cambiar foto"
                    >
                      <i className="ti ti-camera" />
                    </button>
                  )}
                </div>

                <div>
                  <div className="afa-prof-name">{pasajero.nombre}</div>
                  {pasajero.empresa && <div className="afa-prof-co">{pasajero.empresa}</div>}
                  {pasajero.dni && <div className="afa-prof-dni">DNI: {pasajero.dni}</div>}
                  <div className="afa-foto-hint">
                    <i className="ti ti-camera" style={{fontSize:11,verticalAlign:-1}} /> Toca el avatar para cambiar foto
                  </div>
                </div>
              </div>

              {/* Error de subida */}
              {fotoErr && (
                <div className="afa-foto-err">⚠️ {fotoErr}</div>
              )}

              {miParada && (
                <div className="afa-info-card">
                  <div className="afa-info-lbl">Mi servicio de hoy</div>
                  {[
                    ["📍 Paradero",      miParada.nombre],
                    ["🕐 Hora estimada", miParada.hora_estimada||"—"],
                    ["🚌 Placa del bus", vehiculo?.placa||"—"],
                    ["👤 Conductor",     conductor?.nombre||"—"],
                    ["📅 Fecha",         miParada.reserva?.fecha_servicio?new Date(miParada.reserva.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long"}):"—"],
                  ].map(([k,v])=>(
                    <div key={k} className="afa-info-row">
                      <span className="afa-info-key">{k}</span>
                      <span className="afa-info-val">{v}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="afa-contact-card">
                <div className="afa-contact-hdr">Contacto AFA Tours Peru</div>
                {[
                  {ico:"ti-phone",          cls:"blue",  lbl:"Central",  val:"(01) 345 3707",              href:"tel:013453707"},
                  {ico:"ti-brand-whatsapp", cls:"green", lbl:"WhatsApp", val:"966 707 225",                href:"https://wa.me/51966707225"},
                  {ico:"ti-mail",           cls:"blue",  lbl:"Email",    val:"transporte@afatoursperu.com",href:"mailto:transporte@afatoursperu.com"},
                ].map(item=>(
                  <a key={item.lbl} href={item.href} className="afa-contact-item">
                    <div className={`afa-contact-icon ${item.cls}`}><i className={`ti ${item.ico}`} /></div>
                    <div>
                      <div className="afa-contact-type">{item.lbl}</div>
                      <div className="afa-contact-val">{item.val}</div>
                    </div>
                    <i className="ti ti-chevron-right afa-contact-arr" />
                  </a>
                ))}
              </div>

              <button className="afa-logout" onClick={salir}>
                <i className="ti ti-door-exit" style={{fontSize:17}} /> Cerrar sesión
              </button>
              <div style={{height:16}} />
            </div>
          )}
        </div>

        {/* ── BOTTOM NAV ── */}
        <nav className="afa-nav">
          {([ {id:"ruta" as Tab, ico:"ti-map-2",      lbl:"Mi Ruta",  badge:alerta5min&&!alertaDismiss&&miEstado!=="embarcado"},
               {id:"qr"   as Tab, ico:"ti-qrcode",     lbl:"Mi QR",    badge:false},
               {id:"perfil" as Tab, ico:"ti-user-circle",lbl:"Perfil",  badge:false},
          ]).map(t=>(
            <button key={t.id} className={`afa-tab${tab===t.id?" active":""}`} onClick={()=>setTab(t.id)}>
              <div className="afa-tab-icon">
                <i className={`ti ${t.ico}`} />
                {t.badge && <div className="afa-tab-badge" />}
              </div>
              <span className="afa-tab-lbl">{t.lbl}</span>
            </button>
          ))}
        </nav>

      </div>
    </>
  );
}