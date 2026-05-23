"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

// ─── TIPOS ────────────────────────────────────────────────────────────────────
type Cliente        = { id: number; nombre: string; empresa: string | null; ruc: string | null; email: string | null; telefono: string | null; };
type Reserva        = { id: number; origen: string; destino: string; fecha_servicio: string | null; hora_servicio: string | null; estado: string; precio_cliente: number; vehiculo_id: number | null; conductor_id: number | null; cotizacion_id: number | null; created_at: string; };
type Parada         = { id: number; reserva_id: number; orden: number; nombre: string; direccion: string | null; lat: number | null; lng: number | null; hora_estimada: string | null; estado: string; };
type Boarding       = { id: number; pasajero_id: number; parada_id: number; timestamp: string; metodo: string; pasajero?: { nombre: string; dni: string | null; empresa: string | null; }; };
type PasajeroParada = { id: number; parada_id: number; pasajero_id: number; estado: string; pasajero?: { nombre: string; dni: string | null; }; };
type GPS            = { lat: number; lng: number; velocidad: number; timestamp: string; };
type EmpresaPerfil  = { nombre: string | null; logo_url: string | null; color_primario: string | null; telefono: string | null; email: string | null; slogan: string | null; };
type Tab = "dashboard" | "activos" | "historial" | "reporte";

// ─── PALETA ────────────────────────────────────────────────────────────────────
const C = {
  navy: "#0b315f", navyDark: "#07203f", navyLight: "#1a4a7a",
  white: "#FFFFFF", gray50: "#F8FAFC", gray100: "#F1F5F9",
  gray200: "#E2E8F0", gray400: "#94A3B8", gray600: "#475569", gray800: "#1E293B",
  green: "#16a34a", red: "#dc2626", amber: "#d97706", blue: "#1d4ed8",
};

const ESTADO: Record<string, { bg: string; c: string; label: string; dot: string }> = {
  pendiente:  { bg: "#fef9c3", c: "#854d0e", label: "Pendiente",  dot: "#f59e0b" },
  completado: { bg: "#dcfce7", c: "#166534", label: "Completado", dot: "#16a34a" },
  realizado:  { bg: "#dcfce7", c: "#166534", label: "Realizado",  dot: "#16a34a" },
  cancelado:  { bg: "#fee2e2", c: "#991b1b", label: "Cancelado",  dot: "#dc2626" },
  confirmado: { bg: "#dbeafe", c: "#1d4ed8", label: "Confirmado", dot: "#3b82f6" },
  en_curso:   { bg: "#d1fae5", c: "#065f46", label: "En curso",   dot: "#10b981" },
};

// ─── SESSION ──────────────────────────────────────────────────────────────────
const SK = "afa_cliente_portal_v1";
function saveSession(c: Cliente) { localStorage.setItem(SK, JSON.stringify({ c, exp: Date.now() + 8 * 3600000 })); }
function loadSession(): Cliente | null { try { const r = localStorage.getItem(SK); if (!r) return null; const { c, exp } = JSON.parse(r); if (Date.now() > exp) { localStorage.removeItem(SK); return null; } return c; } catch { return null; } }
function clearSession() { localStorage.removeItem(SK); }

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmtFecha    = (f: string | null) => f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const fmtFechaLrg = (f: string | null) => f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { weekday: "short", day: "2-digit", month: "short" }) : "—";
const fmtTs       = (ts: string) => new Date(ts).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
const fmtSoles    = (n: number) => `S/ ${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2 })}`;

function Badge({ estado }: { estado: string }) {
  const e = ESTADO[estado] || { bg: "#f3f4f6", c: "#374151", label: estado, dot: "#9ca3af" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: e.bg, color: e.c, whiteSpace: "nowrap" as const }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: e.dot, display: "inline-block" }} />
      {e.label}
    </span>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function ClientePortal() {
  const [cliente,        setCliente]        = useState<Cliente | null>(null);
  const [empresa,        setEmpresa]        = useState<EmpresaPerfil | null>(null);
  const [initing,        setIniting]        = useState(true);
  const [tab,            setTab]            = useState<Tab>("dashboard");

  // Login
  const [rucInput,  setRucInput]  = useState("");
  const [loginErr,  setLoginErr]  = useState("");
  const [loginLoad, setLoginLoad] = useState(false);

  // Datos
  const [reservas,       setReservas]       = useState<Reserva[]>([]);
  const [paradas,        setParadas]        = useState<Record<number, Parada[]>>({});
  const [boarding,       setBoarding]       = useState<Record<number, Boarding[]>>({});
  const [ppList,         setPPList]         = useState<Record<number, PasajeroParada[]>>({});
  const [gpsActual,      setGpsActual]      = useState<GPS | null>(null);
  const [vehiculoActivo, setVehiculoActivo] = useState<number | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [reservaSel,     setReservaSel]     = useState<Reserva | null>(null);

  // Filtros historial
  const [filtroEstado,  setFiltroEstado]  = useState("todos");
  const [filtroBusqueda, setFiltroBusqueda] = useState("");

  // Mapa
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const busMarker    = useRef<mapboxgl.Marker | null>(null);
  const [mapListo,   setMapListo] = useState(false);

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from("empresa_perfil").select("nombre,logo_url,color_primario,telefono,email,slogan").eq("id", 1).maybeSingle()
      .then(({ data }) => { if (data) setEmpresa(data as EmpresaPerfil); });
    const saved = loadSession();
    if (saved) { setCliente(saved); cargarDatos(saved.id); }
    setIniting(false);
  }, []);

  // ── Login ─────────────────────────────────────────────────────────────────
  async function login() {
    if (!rucInput.trim()) { setLoginErr("Ingresa tu RUC o nombre de empresa"); return; }
    setLoginErr(""); setLoginLoad(true);
    const q = rucInput.trim();
    const { data } = await supabase.from("clientes").select("*")
      .or(`ruc.eq.${q},nombre.ilike.%${q}%,empresa.ilike.%${q}%`).limit(1).single();
    if (!data) { setLoginErr("No se encontró ningún cliente con ese RUC o nombre."); setLoginLoad(false); return; }
    saveSession(data); setCliente(data); await cargarDatos(data.id); setLoginLoad(false);
  }

  // ── Cargar datos ──────────────────────────────────────────────────────────
  const cargarDatos = useCallback(async (cid: number) => {
    setLoading(true);
    const { data: res } = await supabase.from("reservas").select("*").eq("cliente_id", cid).order("fecha_servicio", { ascending: false });
    const rList = (res || []) as Reserva[];
    setReservas(rList);
    const hoy = new Date().toISOString().split("T")[0];
    const activo = rList.find(r => r.fecha_servicio === hoy && r.estado !== "cancelado");
    if (activo?.vehiculo_id) {
      setVehiculoActivo(activo.vehiculo_id);
      const { data: gps } = await supabase.from("ubicaciones_gps").select("*").eq("vehiculo_id", activo.vehiculo_id).order("timestamp", { ascending: false }).limit(1);
      if (gps?.[0]) setGpsActual(gps[0]);
    }
    setLoading(false);
  }, []);

  // ── Cargar detalles ───────────────────────────────────────────────────────
  const cargarDetalle = useCallback(async (r: Reserva) => {
    setReservaSel(r); setTab("reporte");
    if (paradas[r.id]) return;
    const [pRes, bRes] = await Promise.all([
      supabase.from("paradas").select("*").eq("reserva_id", r.id).order("orden"),
      supabase.from("boarding_log").select("*, pasajero:pasajeros(nombre,dni,empresa)").eq("reserva_id", r.id).order("timestamp"),
    ]);
    setParadas(prev => ({ ...prev, [r.id]: pRes.data || [] }));
    setBoarding(prev => ({ ...prev, [r.id]: bRes.data || [] }));
    const ps = pRes.data || [];
    if (ps.length > 0) {
      const { data: pp } = await supabase.from("pasajeros_parada").select("*, pasajero:pasajeros(nombre,dni)").in("parada_id", ps.map((p: any) => p.id));
      setPPList(prev => ({ ...prev, [r.id]: pp || [] }));
    }
  }, [paradas]);

  // ── Realtime GPS ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!vehiculoActivo) return;
    const ch = supabase.channel(`cliente-gps-${vehiculoActivo}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps", filter: `vehiculo_id=eq.${vehiculoActivo}` },
        (payload: any) => setGpsActual(payload.new as GPS))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [vehiculoActivo]);

  // ── Mapa ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || map.current || !cliente || tab !== "activos") return;
    map.current = new mapboxgl.Map({ container: mapContainer.current, style: "mapbox://styles/mapbox/light-v11", center: [-77.0428, -12.0464], zoom: 12 });
    map.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.current.on("load", () => setMapListo(true));
    return () => { map.current?.remove(); map.current = null; setMapListo(false); };
  }, [tab, cliente]);

  useEffect(() => {
    if (!mapListo || !map.current || !gpsActual) return;
    const el = document.createElement("div");
    el.style.cssText = `width:52px;height:52px;border-radius:50%;background:${C.navy};border:3px solid white;display:flex;align-items:center;justify-content:center;font-size:24px;box-shadow:0 4px 20px rgba(11,49,95,0.5);cursor:pointer;`;
    el.innerHTML = "🚌";
    if (busMarker.current) busMarker.current.setLngLat([Number(gpsActual.lng), Number(gpsActual.lat)]);
    else { busMarker.current = new mapboxgl.Marker({ element: el }).setLngLat([Number(gpsActual.lng), Number(gpsActual.lat)]).addTo(map.current!); }
    map.current.flyTo({ center: [Number(gpsActual.lng), Number(gpsActual.lat)], zoom: 14, duration: 1500 });
  }, [gpsActual, mapListo]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const hoy   = new Date().toISOString().split("T")[0];
  const esteM = new Date().toISOString().slice(0, 7);
  const serviciosMes    = reservas.filter(r => r.fecha_servicio?.startsWith(esteM)).length;
  const serviciosTotal  = reservas.length;
  const gastosTotal     = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const completados     = reservas.filter(r => r.estado === "completado" || r.estado === "realizado").length;
  const puntualidad     = serviciosTotal > 0 ? Math.round((completados / serviciosTotal) * 100) : 0;
  const pasajerosTotal  = Object.values(boarding).flat().length;
  const servicioActivo  = reservas.find(r => r.fecha_servicio === hoy && r.estado !== "cancelado");
  const proximosSvcs    = reservas.filter(r => r.fecha_servicio && r.fecha_servicio > hoy && r.estado !== "cancelado").slice(0, 5).reverse();

  // ── Historial filtrado ────────────────────────────────────────────────────
  const reservasFiltradas = reservas.filter(r => {
    const cumpleEstado  = filtroEstado === "todos" || r.estado === filtroEstado;
    const cumpleBusqueda = !filtroBusqueda || r.origen.toLowerCase().includes(filtroBusqueda.toLowerCase()) || r.destino.toLowerCase().includes(filtroBusqueda.toLowerCase()) || fmtFecha(r.fecha_servicio).includes(filtroBusqueda);
    return cumpleEstado && cumpleBusqueda;
  });

  // ── PDF ───────────────────────────────────────────────────────────────────
  function generarPDF(r: Reserva) {
    const ps = paradas[r.id] || [];
    const bl = boarding[r.id] || [];
    const pp = ppList[r.id] || [];
    const totalEsp = pp.length, totalEmb = bl.length;
    const pct = totalEsp > 0 ? Math.round((totalEmb / totalEsp) * 100) : 0;
    const noEmb = pp.filter(p => !bl.find(b => b.pasajero_id === p.pasajero_id));
    const empNombre = empresa?.nombre || "AFA Tours Peru S.A.C.";
    const empTel = empresa?.telefono || "966 707 225";
    const empEmail = empresa?.email || "transporte@afatoursperu.com";

    const filas = ps.map(p => {
      const bP = bl.filter(b => b.parada_id === p.id);
      const ppP = pp.filter(x => x.parada_id === p.id);
      return `
        <tr style="background:#eef3f8"><td colspan="4" style="padding:8px 12px;font-weight:900;color:#0b315f;font-size:11px;border:1px solid #e5e7eb">
          ${p.orden}. ${p.nombre}${p.hora_estimada ? ` · ${p.hora_estimada}` : ""} <span style="font-weight:400;color:#6b7280">(${bP.length}/${ppP.length} embarcaron)</span>
        </td></tr>
        ${ppP.map(x => { const emb = bl.find(b => b.pasajero_id === x.pasajero_id && b.parada_id === p.id); return `<tr>
          <td style="padding:7px 12px;border:1px solid #e5e7eb">${x.pasajero?.nombre || `#${x.pasajero_id}`}</td>
          <td style="padding:7px 12px;border:1px solid #e5e7eb;font-family:monospace">${x.pasajero?.dni || "—"}</td>
          <td style="padding:7px 12px;border:1px solid #e5e7eb;text-align:center"><span style="font-weight:900;color:${emb ? "#16a34a" : "#dc2626"}">${emb ? "✅ Embarcó" : "❌ No asistió"}</span></td>
          <td style="padding:7px 12px;border:1px solid #e5e7eb;color:#6b7280">${emb ? fmtTs(emb.timestamp) : "—"}</td>
        </tr>`; }).join("")}`;
    }).join("");

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Reporte — ${fmtFecha(r.fecha_servicio)}</title>
<style>
@page{size:A4;margin:18mm 15mm}*{box-sizing:border-box}
body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0}
.hd{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #0b315f;padding-bottom:14px;margin-bottom:18px}
.hd h1{font-size:20px;font-weight:900;color:#0b315f;margin:0}
.hd p{color:#6b7280;font-size:11px;margin:3px 0 0}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.box{border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px}
.bt{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid #f1f5f9;padding-bottom:6px;margin-bottom:10px}
.kpi{text-align:center;border-radius:8px;padding:10px}
.kpi .n{font-size:26px;font-weight:900;margin:4px 0}
.kpi .l{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;font-size:10.5px;margin-bottom:14px}
thead{background:#0b315f;color:white}thead th{padding:8px 12px;text-align:left;font-size:10px;letter-spacing:.3px}
.ft{border-top:1px solid #e5e7eb;padding-top:10px;text-align:center;font-size:9px;color:#9ca3af;margin-top:24px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="hd">
  <div><h1>${empNombre}</h1><p>📞 ${empTel} &nbsp;·&nbsp; ✉️ ${empEmail}</p></div>
  <div style="text-align:right"><p style="font-weight:900;font-size:15px;color:#0b315f;margin:0">REPORTE DE SERVICIO</p>
    <p style="color:#6b7280;font-size:10px;margin:3px 0">Generado: ${new Date().toLocaleDateString("es-PE")} ${new Date().toLocaleTimeString("es-PE",{hour:"2-digit",minute:"2-digit"})}</p>
  </div>
</div>
<div class="g2">
  <div class="box"><div class="bt">Datos del servicio</div>
    <div style="margin:4px 0"><b>CLIENTE:</b> ${cliente?.empresa || cliente?.nombre}</div>
    <div style="margin:4px 0"><b>RUC:</b> ${cliente?.ruc || "—"}</div>
    <div style="margin:4px 0"><b>FECHA:</b> ${fmtFecha(r.fecha_servicio)}</div>
    <div style="margin:4px 0"><b>HORA:</b> ${r.hora_servicio?.slice(0,5) || "—"}</div>
    <div style="margin:4px 0"><b>RUTA:</b> ${r.origen} → ${r.destino}</div>
  </div>
  <div class="box"><div class="bt">Cumplimiento</div>
    <div style="display:flex;justify-content:space-between;margin:4px 0"><span>Pasajeros esperados</span><b>${totalEsp}</b></div>
    <div style="display:flex;justify-content:space-between;margin:4px 0"><span>Embarcaron</span><b style="color:#16a34a">${totalEmb}</b></div>
    <div style="display:flex;justify-content:space-between;margin:4px 0"><span>No asistieron</span><b style="color:#dc2626">${noEmb.length}</b></div>
    <div style="margin-top:10px;height:10px;background:#fee2e2;border-radius:5px;overflow:hidden">
      <div style="height:100%;background:#16a34a;width:${pct}%;border-radius:5px"></div>
    </div>
    <p style="font-weight:900;font-size:18px;color:#0b315f;margin:8px 0 0">${pct}% de cumplimiento</p>
  </div>
</div>
<div class="box" style="margin-bottom:14px"><div class="bt">Detalle de embarques por parada</div>
  <table><thead><tr><th>Pasajero</th><th>DNI</th><th>Estado</th><th>Hora embarque</th></tr></thead>
  <tbody>${filas || `<tr><td colspan="4" style="text-align:center;padding:14px;color:#9ca3af">Sin datos de embarque</td></tr>`}</tbody></table>
</div>
${noEmb.length > 0 ? `<div class="box" style="margin-bottom:14px;border-color:#fca5a5">
  <div class="bt" style="color:#dc2626">⚠ No se presentaron (${noEmb.length})</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
    ${noEmb.map(x => `<div style="background:#fff5f5;border-radius:6px;padding:6px 10px;font-size:10px"><b>${x.pasajero?.nombre||`#${x.pasajero_id}`}</b><br/><span style="color:#9ca3af">${x.pasajero?.dni||"Sin DNI"}</span></div>`).join("")}
  </div></div>` : ""}
<div class="box"><div class="bt">Firma de conformidad</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:20px">
    <div style="text-align:center"><div style="border-top:1px solid #333;padding-top:6px;margin-top:36px;font-size:10px;color:#6b7280"><b>${empNombre}</b><br/>Representante legal</div></div>
    <div style="text-align:center"><div style="border-top:1px solid #333;padding-top:6px;margin-top:36px;font-size:10px;color:#6b7280"><b>${cliente?.empresa||cliente?.nombre}</b><br/>Responsable del servicio</div></div>
  </div>
</div>
<div class="ft">${empNombre} &nbsp;·&nbsp; ${empTel} &nbsp;·&nbsp; ${empEmail}</div>
<script>window.onload=()=>window.print()</script></body></html>`;
    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); }
  }

  // ─── LOADING ─────────────────────────────────────────────────────────────
  if (initing) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${C.navyDark} 0%, ${C.navy} 60%, ${C.navyLight} 100%)` }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 44, height: 44, border: "4px solid rgba(255,255,255,0.2)", borderTopColor: "white", borderRadius: "50%", margin: "0 auto 16px", animation: "spin 0.8s linear infinite" }} />
        <p style={{ color: "rgba(255,255,255,0.7)", fontWeight: 700, fontSize: 13 }}>Cargando portal...</p>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ─── LOGIN ────────────────────────────────────────────────────────────────
  if (!cliente) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.gray50, fontFamily: "system-ui,sans-serif" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* Hero */}
      <div style={{ background: `linear-gradient(160deg, ${C.navyDark} 0%, ${C.navy} 55%, #1a4a8a 100%)`, padding: "56px 24px 48px", textAlign: "center" }}>
        {empresa?.logo_url
          ? <img src={empresa.logo_url} alt="Logo" style={{ height: 60, objectFit: "contain", margin: "0 auto 20px", display: "block", filter: "brightness(0) invert(1)" }} />
          : <div style={{ width: 72, height: 72, background: "rgba(255,255,255,0.12)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, margin: "0 auto 20px", border: "1px solid rgba(255,255,255,0.15)" }}>🏢</div>
        }
        <h1 style={{ color: "white", fontWeight: 900, fontSize: 24, margin: 0 }}>Portal Empresarial</h1>
        <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginTop: 8 }}>
          {empresa?.nombre || "AFA Tours Peru"} · Seguimiento de servicios corporativos
        </p>
      </div>

      {/* Tarjeta login */}
      <div style={{ flex: 1, padding: "0 24px 40px", maxWidth: 460, margin: "0 auto", width: "100%", boxSizing: "border-box" as const }}>
        <div style={{ background: "white", borderRadius: 24, boxShadow: "0 8px 40px rgba(11,49,95,0.12)", padding: "32px 32px", marginTop: -24, animation: "fadeUp 0.35s ease" }}>
          <p style={{ color: C.gray600, fontSize: 14, textAlign: "center", marginBottom: 24, marginTop: 0 }}>
            Ingresa tu RUC o nombre de empresa para acceder a tus reportes y seguimiento
          </p>

          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.gray600, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 8 }}>
            RUC o nombre de empresa
          </label>
          <input
            value={rucInput}
            onChange={e => { setRucInput(e.target.value); setLoginErr(""); }}
            onKeyDown={e => e.key === "Enter" && login()}
            placeholder="Ej: 20123456789 o Compañía Minera ABC"
            style={{ width: "100%", padding: "14px 18px", borderRadius: 14, border: `2px solid ${rucInput ? C.navy : C.gray200}`, fontSize: 15, fontWeight: 600, outline: "none", boxSizing: "border-box" as const, color: C.gray800, marginBottom: 12, transition: "border-color 0.15s" }}
          />

          {loginErr && (
            <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "10px 16px", marginBottom: 12 }}>
              <p style={{ color: C.red, fontSize: 13, fontWeight: 700, margin: 0, textAlign: "center" }}>⚠️ {loginErr}</p>
            </div>
          )}

          <button
            onClick={login}
            disabled={loginLoad || !rucInput.trim()}
            style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: "none", background: rucInput ? C.navy : C.gray200, color: "white", fontSize: 15, fontWeight: 900, cursor: rucInput ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, transition: "background 0.15s" }}
          >
            {loginLoad
              ? <><span style={{ width: 18, height: 18, border: "3px solid rgba(255,255,255,0.3)", borderTopColor: "white", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} /> Buscando...</>
              : "Acceder al portal →"
            }
          </button>
        </div>

        {/* ¿Qué puedo ver? */}
        <div style={{ marginTop: 24, background: "white", borderRadius: 20, padding: "20px 24px", border: `1px solid ${C.gray200}` }}>
          <p style={{ color: C.navy, fontWeight: 900, fontSize: 13, margin: "0 0 14px" }}>¿Qué puedo ver aquí?</p>
          {[
            ["📊", "Dashboard con KPIs de todos tus servicios"],
            ["🚌", "Seguimiento GPS en tiempo real del bus asignado"],
            ["📋", "Reporte de embarque: quién subió y a qué hora"],
            ["📄", "Descarga de reportes PDF para auditoría"],
          ].map(([icon, texto]) => (
            <div key={texto} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
              <p style={{ color: C.gray600, fontSize: 13, margin: 0 }}>{texto}</p>
            </div>
          ))}
        </div>

        <p style={{ textAlign: "center", color: C.gray400, fontSize: 12, marginTop: 20 }}>
          ¿Problemas? <a href={`tel:${empresa?.telefono || "966707225"}`} style={{ color: C.navy, fontWeight: 700 }}>{empresa?.telefono || "966 707 225"}</a>
        </p>
      </div>
    </div>
  );

  // ─── PORTAL AUTENTICADO ────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.gray50, fontFamily: "system-ui,sans-serif" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.15)}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* ── HEADER ── */}
      <div style={{ background: `linear-gradient(90deg, ${C.navyDark} 0%, ${C.navy} 100%)`, padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 30, boxShadow: "0 2px 16px rgba(7,32,63,0.35)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {empresa?.logo_url
            ? <img src={empresa.logo_url} alt="Logo" style={{ height: 34, objectFit: "contain", filter: "brightness(0) invert(1)", opacity: 0.9 }} />
            : <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🏢</div>
          }
          <div style={{ width: "1px", height: 28, background: "rgba(255,255,255,0.15)" }} />
          <div>
            <p style={{ color: "white", fontWeight: 800, fontSize: 13, margin: 0 }}>{cliente.empresa || cliente.nombre}</p>
            <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 10, margin: 0 }}>RUC: {cliente.ruc || "—"} · Portal Empresarial</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {servicioActivo && (
            <div style={{ background: "rgba(22,163,74,0.2)", border: "1px solid rgba(74,222,128,0.4)", borderRadius: 8, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ade80", display: "inline-block", animation: "pulse 1.5s infinite" }} />
              <p style={{ color: "#4ade80", fontSize: 11, fontWeight: 700, margin: 0 }}>Servicio activo</p>
            </div>
          )}
          <button
            onClick={() => { clearSession(); setCliente(null); setReservas([]); }}
            style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "6px 14px", color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >
            Salir
          </button>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.gray200}`, display: "flex", overflowX: "auto" as const, scrollbarWidth: "none" as const }}>
        {([
          { id: "dashboard", icon: "📊", label: "Dashboard" },
          { id: "activos",   icon: "🗺️", label: "En tiempo real", dot: !!servicioActivo },
          { id: "historial", icon: "📋", label: "Historial", badge: reservas.length },
          { id: "reporte",   icon: "📄", label: "Reporte", disabled: !reservaSel },
        ] as any[]).map(t => (
          <button key={t.id} onClick={() => !t.disabled && setTab(t.id)}
            style={{ padding: "13px 22px", border: "none", background: "none", cursor: t.disabled ? "not-allowed" : "pointer", borderBottom: `3px solid ${tab === t.id ? C.navy : "transparent"}`, color: tab === t.id ? C.navy : t.disabled ? C.gray200 : C.gray600, fontWeight: tab === t.id ? 800 : 600, fontSize: 13, whiteSpace: "nowrap" as const, display: "flex", alignItems: "center", gap: 7, position: "relative" as const, transition: "color 0.15s" }}>
            <span>{t.icon}</span> {t.label}
            {t.dot && <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, animation: "pulse 1.5s infinite" }} />}
            {t.badge > 0 && tab !== "historial" && (
              <span style={{ fontSize: 10, fontWeight: 800, background: tab === "historial" ? C.navy : C.gray200, color: tab === "historial" ? "white" : C.gray600, padding: "1px 7px", borderRadius: 20 }}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, padding: "20px 20px 40px", maxWidth: 1120, margin: "0 auto", width: "100%", boxSizing: "border-box" as const }}>

        {/* ════ DASHBOARD ════ */}
        {tab === "dashboard" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 20 }}>

            {/* KPIs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(155px,1fr))", gap: 12 }}>
              {[
                { label: "Servicios este mes", val: serviciosMes,    icon: "🗓️", color: C.navy,  bg: "#eef3f8" },
                { label: "Total histórico",    val: serviciosTotal,  icon: "✅", color: "#166534",bg: "#dcfce7" },
                { label: "Gasto acumulado",    val: fmtSoles(gastosTotal), icon: "💰", color: "#854d0e", bg: "#fef9c3" },
                { label: "Puntualidad",        val: `${puntualidad}%`, icon: "⏱️", color: C.blue,  bg: "#dbeafe" },
                { label: "Pasajeros totales",  val: pasajerosTotal,  icon: "👥", color: "#6d28d9",bg: "#ede9fe" },
              ].map(k => (
                <div key={k.label} style={{ background: k.bg, borderRadius: 18, padding: "18px 20px", border: `1px solid ${k.color}20`, position: "relative" as const, overflow: "hidden" }}>
                  <span style={{ position: "absolute", top: 14, right: 16, fontSize: 26, opacity: 0.25 }}>{k.icon}</span>
                  <p style={{ fontSize: 28, fontWeight: 900, color: k.color, margin: 0 }}>{k.val}</p>
                  <p style={{ fontSize: 11, color: k.color + "b0", fontWeight: 700, textTransform: "uppercase" as const, margin: "5px 0 0", letterSpacing: "0.04em" }}>{k.label}</p>
                </div>
              ))}
            </div>

            {/* Alerta servicio activo */}
            {servicioActivo && (
              <div style={{ background: "#f0fdf4", border: "2px solid #86efac", borderRadius: 20, padding: "20px 24px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 14 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: C.green, animation: "pulse 1.5s infinite", display: "inline-block" }} />
                      <p style={{ color: C.green, fontWeight: 900, fontSize: 14, margin: 0 }}>Servicio en curso HOY</p>
                    </div>
                    <p style={{ color: C.gray800, fontWeight: 800, fontSize: 18, margin: 0 }}>{servicioActivo.origen} → {servicioActivo.destino}</p>
                    <p style={{ color: C.gray600, fontSize: 13, margin: "4px 0 0" }}>
                      🕐 {servicioActivo.hora_servicio?.slice(0,5)} &nbsp;·&nbsp; {fmtFecha(servicioActivo.fecha_servicio)}
                    </p>
                    {gpsActual && <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>📡 Última señal: {fmtTs(gpsActual.timestamp)} · {gpsActual.velocidad} km/h</p>}
                  </div>
                  <button onClick={() => setTab("activos")} style={{ padding: "12px 28px", borderRadius: 14, border: "none", background: C.navy, color: "white", fontWeight: 900, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 14px rgba(11,49,95,0.2)" }}>
                    🗺️ Ver en mapa →
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: proximosSvcs.length > 0 ? "1fr 1fr" : "1fr", gap: 20 }}>

              {/* Próximos servicios */}
              {proximosSvcs.length > 0 && (
                <div style={{ background: C.white, borderRadius: 18, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                  <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.gray100}`, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🔜</span>
                    <p style={{ fontWeight: 900, color: C.gray800, margin: 0, fontSize: 14 }}>Próximos servicios</p>
                  </div>
                  {proximosSvcs.map(r => (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                      <div style={{ background: "#eef3f8", borderRadius: 12, padding: "8px 10px", textAlign: "center", flexShrink: 0, minWidth: 52 }}>
                        <p style={{ color: C.navy, fontWeight: 900, fontSize: 16, margin: 0 }}>{new Date(r.fecha_servicio! + "T00:00:00").getDate()}</p>
                        <p style={{ color: C.gray400, fontSize: 9, fontWeight: 700, margin: 0, textTransform: "uppercase" as const }}>{new Date(r.fecha_servicio! + "T00:00:00").toLocaleDateString("es-PE", { month: "short" })}</p>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.origen} → {r.destino}</p>
                        <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>🕐 {r.hora_servicio?.slice(0,5) || "—"}</p>
                      </div>
                      <Badge estado={r.estado} />
                    </div>
                  ))}
                </div>
              )}

              {/* Últimos servicios */}
              <div style={{ background: C.white, borderRadius: 18, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.gray100}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🕐</span>
                    <p style={{ fontWeight: 900, color: C.gray800, margin: 0, fontSize: 14 }}>Últimos servicios</p>
                  </div>
                  <button onClick={() => setTab("historial")} style={{ color: C.navy, fontSize: 12, fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}>Ver todos →</button>
                </div>
                {loading
                  ? [1,2,3].map(i => (
                    <div key={i} style={{ padding: "14px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                      <div style={{ height: 12, background: "#f3f4f6", borderRadius: 6, marginBottom: 6, width: "70%" }} />
                      <div style={{ height: 10, background: "#f3f4f6", borderRadius: 6, width: "45%" }} />
                    </div>
                  ))
                  : reservas.slice(0, 6).map(r => (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 20px", borderBottom: `1px solid ${C.gray100}`, gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.origen} → {r.destino}</p>
                        <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>{fmtFechaLrg(r.fecha_servicio)} · {r.hora_servicio?.slice(0,5) || "—"}</p>
                      </div>
                      <Badge estado={r.estado} />
                      <span style={{ color: C.navy, fontWeight: 800, fontSize: 13, flexShrink: 0 }}>{fmtSoles(Number(r.precio_cliente))}</span>
                      <button onClick={() => cargarDetalle(r)} style={{ padding: "5px 12px", borderRadius: 8, border: `1px solid ${C.navy}22`, color: C.navy, fontSize: 11, fontWeight: 700, background: "#eef3f8", cursor: "pointer", flexShrink: 0 }}>Ver</button>
                    </div>
                  ))
                }
                {!loading && reservas.length === 0 && (
                  <div style={{ padding: 32, textAlign: "center" }}>
                    <p style={{ fontSize: 32 }}>📋</p>
                    <p style={{ color: C.gray400, fontWeight: 600, fontSize: 14 }}>Sin servicios registrados aún</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ════ EN TIEMPO REAL ════ */}
        {tab === "activos" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>
            {!servicioActivo ? (
              <div style={{ background: C.white, borderRadius: 22, padding: 56, textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ fontSize: 48, margin: "0 0 16px" }}>🚌</p>
                <p style={{ color: C.navy, fontWeight: 900, fontSize: 20, margin: 0 }}>Sin servicio activo hoy</p>
                <p style={{ color: C.gray400, fontSize: 14, marginTop: 8 }}>El seguimiento GPS aparecerá aquí cuando haya un bus asignado para este día.</p>
                <button onClick={() => setTab("historial")} style={{ marginTop: 20, padding: "10px 24px", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Ver historial de servicios →</button>
              </div>
            ) : (
              <>
                {/* Info strip */}
                <div style={{ background: C.white, borderRadius: 18, padding: "16px 24px", boxShadow: "0 1px 8px rgba(0,0,0,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 16 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: C.green, display: "inline-block", animation: "pulse 1.5s infinite" }} />
                      <p style={{ color: C.green, fontWeight: 900, margin: 0, fontSize: 13, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>En ruta</p>
                    </div>
                    <p style={{ color: C.navy, fontWeight: 900, fontSize: 20, margin: 0 }}>{servicioActivo.origen}</p>
                    <p style={{ color: C.gray600, fontSize: 14, margin: "2px 0 0" }}>→ {servicioActivo.destino} &nbsp;·&nbsp; 🕐 {servicioActivo.hora_servicio?.slice(0,5)}</p>
                  </div>
                  {gpsActual && (
                    <div style={{ display: "flex", gap: 10 }}>
                      {[
                        ["🚀", "Velocidad", `${gpsActual.velocidad} km/h`],
                        ["📡", "Última señal", fmtTs(gpsActual.timestamp)],
                      ].map(([ic, lbl, val]) => (
                        <div key={lbl} style={{ background: "#eef3f8", borderRadius: 14, padding: "10px 16px", textAlign: "center" as const }}>
                          <p style={{ fontSize: 18, margin: "0 0 4px" }}>{ic}</p>
                          <p style={{ color: C.navy, fontWeight: 900, fontSize: 16, margin: 0 }}>{val}</p>
                          <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, margin: "2px 0 0", textTransform: "uppercase" as const }}>{lbl}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Mapa */}
                <div style={{ height: 460, borderRadius: 18, overflow: "hidden", boxShadow: "0 2px 16px rgba(0,0,0,0.1)", position: "relative" as const }}>
                  <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
                  {!gpsActual && (
                    <div style={{ position: "absolute" as const, inset: 0, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", background: "rgba(248,250,252,0.9)" }}>
                      <div style={{ width: 36, height: 36, border: `4px solid ${C.gray200}`, borderTopColor: C.navy, borderRadius: "50%", animation: "spin 0.8s linear infinite", marginBottom: 12 }} />
                      <p style={{ color: C.gray600, fontWeight: 700, margin: 0 }}>Esperando señal GPS del conductor...</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ HISTORIAL ════ */}
        {tab === "historial" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
            {/* Filtros */}
            <div style={{ background: C.white, borderRadius: 16, padding: "14px 20px", boxShadow: "0 1px 8px rgba(0,0,0,0.06)", display: "flex", gap: 12, flexWrap: "wrap" as const, alignItems: "center" }}>
              <input
                value={filtroBusqueda}
                onChange={e => setFiltroBusqueda(e.target.value)}
                placeholder="🔍 Buscar por ruta o fecha..."
                style={{ flex: 1, minWidth: 180, border: `1px solid ${C.gray200}`, borderRadius: 10, padding: "8px 14px", fontSize: 13, outline: "none", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                {["todos", "confirmado", "completado", "pendiente", "cancelado"].map(e => (
                  <button key={e} onClick={() => setFiltroEstado(e)}
                    style={{ padding: "6px 14px", borderRadius: 20, border: `1px solid ${filtroEstado === e ? C.navy : C.gray200}`, background: filtroEstado === e ? C.navy : "white", color: filtroEstado === e ? "white" : C.gray600, fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "capitalize" as const }}>
                    {e === "todos" ? "Todos" : (ESTADO[e]?.label || e)}
                  </button>
                ))}
              </div>
              <p style={{ color: C.gray400, fontSize: 12, margin: 0, flexShrink: 0 }}>{reservasFiltradas.length} resultado{reservasFiltradas.length !== 1 ? "s" : ""}</p>
            </div>

            {/* Tabla */}
            <div style={{ background: C.white, borderRadius: 18, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <div style={{ overflowX: "auto" as const }}>
                <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: C.gray50, borderBottom: `1px solid ${C.gray200}` }}>
                      {["Fecha", "Hora", "Ruta", "Estado", "Precio", "Reporte"].map(h => (
                        <th key={h} style={{ padding: "11px 18px", textAlign: "left" as const, fontSize: 10, fontWeight: 800, color: C.gray600, textTransform: "uppercase" as const, letterSpacing: "0.06em", whiteSpace: "nowrap" as const }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reservasFiltradas.length === 0 ? (
                      <tr><td colSpan={6} style={{ padding: "40px 20px", textAlign: "center", color: C.gray400, fontSize: 14 }}>Sin resultados para los filtros seleccionados</td></tr>
                    ) : reservasFiltradas.map(r => (
                      <tr key={r.id} style={{ borderBottom: `1px solid ${C.gray100}` }}
                        onMouseEnter={e => (e.currentTarget.style.background = C.gray50)}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: "12px 18px", fontWeight: 700, color: C.gray800, whiteSpace: "nowrap" as const }}>{fmtFecha(r.fecha_servicio)}</td>
                        <td style={{ padding: "12px 18px", color: C.gray600, whiteSpace: "nowrap" as const }}>{r.hora_servicio?.slice(0,5) || "—"}</td>
                        <td style={{ padding: "12px 18px" }}>
                          <p style={{ fontWeight: 700, color: C.gray800, margin: 0, fontSize: 13, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.origen}</p>
                          <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>→ {r.destino}</p>
                        </td>
                        <td style={{ padding: "12px 18px" }}><Badge estado={r.estado} /></td>
                        <td style={{ padding: "12px 18px", fontWeight: 800, color: C.navy, whiteSpace: "nowrap" as const }}>{fmtSoles(Number(r.precio_cliente))}</td>
                        <td style={{ padding: "12px 18px" }}>
                          <button onClick={() => cargarDetalle(r)} style={{ padding: "6px 16px", borderRadius: 10, border: "none", background: "#eef3f8", color: C.navy, fontSize: 12, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                            📄 Reporte
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/* Totales */}
                  {reservasFiltradas.length > 0 && (
                    <tfoot>
                      <tr style={{ background: "#eef3f8", borderTop: `2px solid ${C.gray200}` }}>
                        <td colSpan={4} style={{ padding: "10px 18px", fontWeight: 800, color: C.navy, fontSize: 12 }}>TOTAL ({reservasFiltradas.length} servicios)</td>
                        <td style={{ padding: "10px 18px", fontWeight: 900, color: C.navy, fontSize: 14 }}>{fmtSoles(reservasFiltradas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0))}</td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ════ REPORTE ════ */}
        {tab === "reporte" && reservaSel && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>
            {/* Cabecera */}
            <div style={{ background: C.white, borderRadius: 18, padding: "20px 24px", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 14 }}>
                <div>
                  <p style={{ color: C.gray400, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, margin: "0 0 6px", letterSpacing: "0.06em" }}>Reporte de servicio</p>
                  <p style={{ color: C.navy, fontWeight: 900, fontSize: 22, margin: 0 }}>{reservaSel.origen} → {reservaSel.destino}</p>
                  <p style={{ color: C.gray600, fontSize: 13, margin: "5px 0 0" }}>
                    📅 {fmtFecha(reservaSel.fecha_servicio)} &nbsp;·&nbsp; 🕐 {reservaSel.hora_servicio?.slice(0,5) || "—"} &nbsp;·&nbsp; <Badge estado={reservaSel.estado} />
                  </p>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button onClick={() => { setReservaSel(null); setTab("historial"); }} style={{ padding: "10px 18px", borderRadius: 12, border: `1px solid ${C.gray200}`, background: "white", color: C.gray600, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                    ← Volver
                  </button>
                  <button onClick={() => generarPDF(reservaSel)} style={{ padding: "12px 24px", borderRadius: 14, border: "none", background: C.navy, color: "white", fontWeight: 900, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 14px rgba(11,49,95,0.2)" }}>
                    📄 Descargar PDF
                  </button>
                </div>
              </div>
            </div>

            {/* KPIs reporte */}
            {(() => {
              const bl = boarding[reservaSel.id] || [];
              const pp = ppList[reservaSel.id] || [];
              const pct = pp.length > 0 ? Math.round((bl.length / pp.length) * 100) : 0;
              const ps = paradas[reservaSel.id] || [];
              return (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10 }}>
                    {[
                      { l: "Esperados",    v: pp.length,            c: C.navy,    bg: "#eef3f8" },
                      { l: "Embarcaron",   v: bl.length,            c: C.green,   bg: "#dcfce7" },
                      { l: "No asistieron",v: pp.length - bl.length,c: C.red,     bg: "#fee2e2" },
                      { l: "Cumplimiento", v: `${pct}%`,            c: C.blue,    bg: "#dbeafe" },
                      { l: "Paradas",      v: ps.length,            c: "#854d0e", bg: "#fef9c3" },
                    ].map(k => (
                      <div key={k.l} style={{ background: k.bg, borderRadius: 16, padding: "14px 18px" }}>
                        <p style={{ fontSize: 26, fontWeight: 900, color: k.c, margin: 0 }}>{k.v}</p>
                        <p style={{ fontSize: 10, color: k.c + "99", fontWeight: 700, textTransform: "uppercase" as const, margin: "5px 0 0", letterSpacing: "0.04em" }}>{k.l}</p>
                      </div>
                    ))}
                  </div>

                  {/* Barra progreso */}
                  <div style={{ background: C.white, borderRadius: 16, padding: "16px 20px", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0 }}>Tasa de embarque</p>
                      <p style={{ fontWeight: 900, color: pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red, fontSize: 14, margin: 0 }}>{pct}%</p>
                    </div>
                    <div style={{ height: 10, background: "#fee2e2", borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ height: "100%", background: pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red, width: `${pct}%`, borderRadius: 5, transition: "width 0.6s ease" }} />
                    </div>
                    <p style={{ color: C.gray400, fontSize: 11, marginTop: 8, marginBottom: 0 }}>{bl.length} de {pp.length} pasajeros esperados embarcaron</p>
                  </div>
                </>
              );
            })()}

            {/* Paradas */}
            {(paradas[reservaSel.id] || []).length === 0 ? (
              <div style={{ background: C.white, borderRadius: 18, padding: 40, textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ fontSize: 36 }}>📋</p>
                <p style={{ color: C.navy, fontWeight: 700, margin: 0 }}>Sin paradas configuradas en este servicio</p>
                <p style={{ color: C.gray400, fontSize: 13 }}>Los datos de boarding aparecerán cuando se configuren los paraderos</p>
              </div>
            ) : (paradas[reservaSel.id] || []).map(p => {
              const bParada = (boarding[reservaSel.id] || []).filter(b => b.parada_id === p.id);
              const ppParada = (ppList[reservaSel.id] || []).filter(x => x.parada_id === p.id);
              const pct = ppParada.length > 0 ? Math.round((bParada.length / ppParada.length) * 100) : 0;
              return (
                <div key={p.id} style={{ background: C.white, borderRadius: 18, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                  <div style={{ padding: "14px 20px", background: C.gray50, borderBottom: `1px solid ${C.gray100}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 32, height: 32, borderRadius: "50%", background: p.estado === "completada" ? C.navy : C.gray200, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 13, fontWeight: 900, flexShrink: 0 }}>{p.orden}</div>
                      <div>
                        <p style={{ color: C.gray800, fontWeight: 900, fontSize: 15, margin: 0 }}>{p.nombre}</p>
                        {p.hora_estimada && <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>🕐 {p.hora_estimada}</p>}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" as const }}>
                      <p style={{ color: C.navy, fontWeight: 900, fontSize: 18, margin: 0 }}>{bParada.length}/{ppParada.length}</p>
                      <p style={{ color: pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red, fontSize: 11, fontWeight: 800, margin: "2px 0 0" }}>{pct}% cumplimiento</p>
                    </div>
                  </div>
                  {ppParada.length > 0 ? (
                    <div style={{ overflowX: "auto" as const }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "#f8fafc" }}>
                            {["Pasajero", "DNI", "Estado", "Hora embarque", "Método"].map(h => (
                              <th key={h} style={{ padding: "9px 18px", textAlign: "left" as const, fontSize: 10, fontWeight: 800, color: C.gray600, textTransform: "uppercase" as const, borderBottom: `1px solid ${C.gray200}`, letterSpacing: "0.05em" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {ppParada.map(x => {
                            const emb = bParada.find(b => b.pasajero_id === x.pasajero_id);
                            return (
                              <tr key={x.id} style={{ borderBottom: `1px solid ${C.gray100}`, background: emb ? "#f0fdf4" : "#fff5f5" }}>
                                <td style={{ padding: "11px 18px", fontWeight: 700, color: C.gray800 }}>{x.pasajero?.nombre || `#${x.pasajero_id}`}</td>
                                <td style={{ padding: "11px 18px", fontFamily: "monospace", color: C.gray600, fontSize: 12 }}>{x.pasajero?.dni || "—"}</td>
                                <td style={{ padding: "11px 18px" }}>
                                  <span style={{ fontSize: 11, fontWeight: 800, padding: "4px 12px", borderRadius: 20, background: emb ? "#dcfce7" : "#fee2e2", color: emb ? C.green : C.red }}>
                                    {emb ? "✅ Embarcó" : "❌ No asistió"}
                                  </span>
                                </td>
                                <td style={{ padding: "11px 18px", color: C.gray600 }}>{emb ? fmtTs(emb.timestamp) : "—"}</td>
                                <td style={{ padding: "11px 18px", color: C.gray400, fontSize: 11 }}>{emb ? (emb.metodo === "qr" ? "📷 QR" : "✋ Manual") : "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ padding: 20, textAlign: "center" as const, color: C.gray400, fontSize: 13 }}>Sin pasajeros asignados a esta parada</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
