"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken = "pk.eyJ1IjoiYWZhdG91cnNwZXJ1IiwiYSI6ImNtb3J6aW5qbzAwemkyc29tOGt6NDh0NWgifQ.fMNK4OX1_V6KYEUq-PKO3A";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Cliente = { id: number; nombre: string; empresa: string | null; ruc: string | null; email: string | null; telefono: string | null; };
type Reserva = { id: number; origen: string; destino: string; fecha_servicio: string | null; hora_servicio: string | null; estado: string; precio_cliente: number; vehiculo_id: number | null; conductor_id: number | null; cotizacion_id: number | null; created_at: string; };
type Parada  = { id: number; reserva_id: number; orden: number; nombre: string; direccion: string | null; lat: number | null; lng: number | null; hora_estimada: string | null; estado: string; };
type Boarding = { id: number; pasajero_id: number; parada_id: number; timestamp: string; metodo: string; pasajero?: { nombre: string; dni: string | null; empresa: string | null; }; };
type PasajeroParada = { id: number; parada_id: number; pasajero_id: number; estado: string; pasajero?: { nombre: string; dni: string | null; }; };
type GPS    = { lat: number; lng: number; velocidad: number; timestamp: string; };

type Tab = "dashboard" | "activos" | "historial" | "reporte";

// ─── COLORES ─────────────────────────────────────────────────────────────────
const C = { navy: "#0b315f", navy2: "#1e40af", white: "#FFFFFF", gray50: "#F8FAFC", gray100: "#F1F5F9", gray200: "#E2E8F0", gray400: "#94A3B8", gray600: "#475569", gray800: "#1E293B", green: "#16a34a", red: "#dc2626", amber: "#d97706" };

// ─── SESSION ──────────────────────────────────────────────────────────────────
const SK = "afa_cliente_portal_v1";
function saveSession(c: Cliente) { localStorage.setItem(SK, JSON.stringify({ c, exp: Date.now() + 8 * 3600000 })); }
function loadSession(): Cliente | null { try { const r = localStorage.getItem(SK); if (!r) return null; const { c, exp } = JSON.parse(r); if (Date.now() > exp) { localStorage.removeItem(SK); return null; } return c; } catch { return null; } }
function clearSession() { localStorage.removeItem(SK); }

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function fmtFecha(f: string | null) { if (!f) return "—"; return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }); }
function fmtTs(ts: string) { return new Date(ts).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }); }
function fmtSoles(n: number) { return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2 })}`; }

// ─── PAGE ─────────────────────────────────────────────────────────────────────
export default function ClientePortal() {
  const [cliente,    setCliente]    = useState<Cliente | null>(null);
  const [initing,    setIniting]    = useState(true);
  const [tab,        setTab]        = useState<Tab>("dashboard");

  // Login
  const [rucInput,   setRucInput]   = useState("");
  const [loginErr,   setLoginErr]   = useState("");
  const [loginLoad,  setLoginLoad]  = useState(false);

  // Datos
  const [reservas,   setReservas]   = useState<Reserva[]>([]);
  const [paradas,    setParadas]    = useState<Record<number, Parada[]>>({});
  const [boarding,   setBoarding]   = useState<Record<number, Boarding[]>>({});
  const [ppList,     setPPList]     = useState<Record<number, PasajeroParada[]>>({});
  const [gpsActual,  setGpsActual]  = useState<GPS | null>(null);
  const [vehiculoActivo, setVehiculoActivo] = useState<number | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [reservaSel, setReservaSel] = useState<Reserva | null>(null);

  // Mapa
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const busMarker    = useRef<mapboxgl.Marker | null>(null);
  const [mapListo,   setMapListo]   = useState(false);

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = loadSession();
    if (saved) { setCliente(saved); cargarDatos(saved.id); }
    setIniting(false);
  }, []);

  // ── Login ────────────────────────────────────────────────────────────────
  async function login() {
    if (!rucInput.trim()) { setLoginErr("Ingresa tu RUC o nombre de empresa"); return; }
    setLoginErr(""); setLoginLoad(true);
    const q = rucInput.trim();
    const { data } = await supabase.from("clientes").select("*")
      .or(`ruc.eq.${q},nombre.ilike.%${q}%,empresa.ilike.%${q}%`)
      .limit(1).single();
    if (!data) { setLoginErr("No se encontró ningún cliente con ese RUC o nombre."); setLoginLoad(false); return; }
    saveSession(data); setCliente(data); await cargarDatos(data.id); setLoginLoad(false);
  }

  // ── Cargar datos ──────────────────────────────────────────────────────────
  const cargarDatos = useCallback(async (cid: number) => {
    setLoading(true);
    const { data: res } = await supabase.from("reservas").select("*").eq("cliente_id", cid).order("fecha_servicio", { ascending: false });
    const rList = (res || []) as Reserva[];
    setReservas(rList);

    // Buscar servicio activo hoy
    const hoy = new Date().toISOString().split("T")[0];
    const activo = rList.find(r => r.fecha_servicio === hoy && r.estado !== "cancelado");
    if (activo?.vehiculo_id) {
      setVehiculoActivo(activo.vehiculo_id);
      const { data: gps } = await supabase.from("ubicaciones_gps").select("*").eq("vehiculo_id", activo.vehiculo_id).order("timestamp", { ascending: false }).limit(1);
      if (gps && gps[0]) setGpsActual(gps[0]);
    }
    setLoading(false);
  }, []);

  // ── Cargar detalles de una reserva ────────────────────────────────────────
  const cargarDetalleReserva = useCallback(async (r: Reserva) => {
    setReservaSel(r);
    setTab("reporte");
    if (paradas[r.id]) return;
    const [pRes, bRes] = await Promise.all([
      supabase.from("paradas").select("*").eq("reserva_id", r.id).order("orden"),
      supabase.from("boarding_log").select("*, pasajero:pasajeros(nombre,dni,empresa)").eq("reserva_id", r.id).order("timestamp"),
    ]);
    setParadas(prev => ({ ...prev, [r.id]: pRes.data || [] }));
    setBoarding(prev => ({ ...prev, [r.id]: bRes.data || [] }));
    // Pasajeros asignados por parada
    const ps = pRes.data || [];
    if (ps.length > 0) {
      const { data: pp } = await supabase.from("pasajeros_parada").select("*, pasajero:pasajeros(nombre,dni)").in("parada_id", ps.map(p => p.id));
      setPPList(prev => ({ ...prev, [r.id]: pp || [] }));
    }
  }, [paradas]);

  // ── Realtime GPS ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!vehiculoActivo) return;
    const ch = supabase.channel(`cliente-gps-${vehiculoActivo}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps", filter: `vehiculo_id=eq.${vehiculoActivo}` },
        (payload) => setGpsActual(payload.new as GPS))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [vehiculoActivo]);

  // ── Mapa ─────────────────────────────────────────────────────────────────
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
    el.style.cssText = `width:48px;height:48px;border-radius:50%;background:${C.navy};border:3px solid white;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 16px rgba(11,49,95,0.4);`;
    el.innerHTML = "🚌";
    if (busMarker.current) busMarker.current.setLngLat([Number(gpsActual.lng), Number(gpsActual.lat)]);
    else { busMarker.current = new mapboxgl.Marker({ element: el }).setLngLat([Number(gpsActual.lng), Number(gpsActual.lat)]).addTo(map.current!); }
    map.current.flyTo({ center: [Number(gpsActual.lng), Number(gpsActual.lat)], zoom: 14, duration: 1500 });
  }, [gpsActual, mapListo]);

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const hoy = new Date().toISOString().split("T")[0];
  const esteM = new Date().toISOString().slice(0, 7);
  const serviciosMes  = reservas.filter(r => r.fecha_servicio?.startsWith(esteM)).length;
  const serviciosTotal = reservas.length;
  const gastosTotal    = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const completados    = reservas.filter(r => r.estado === "completado" || r.estado === "realizado").length;
  const puntualidad    = serviciosTotal > 0 ? Math.round((completados / serviciosTotal) * 100) : 0;
  const pasajerosTotal = Object.values(boarding).flat().length;
  const servicioActivo = reservas.find(r => r.fecha_servicio === hoy && r.estado !== "cancelado");

  // ── Generar reporte PDF ───────────────────────────────────────────────────
  function generarReportePDF(r: Reserva) {
    const ps = paradas[r.id] || [];
    const bl = boarding[r.id] || [];
    const pp = ppList[r.id] || [];
    const fechaDoc = fmtFecha(r.fecha_servicio);
    const totalEsperados = pp.length;
    const totalEmbarcados = bl.length;
    const pct = totalEsperados > 0 ? Math.round((totalEmbarcados / totalEsperados) * 100) : 0;
    const noEmbarcaron = pp.filter(p => !bl.find(b => b.pasajero_id === p.pasajero_id));

    const filasPorParada = ps.map(p => {
      const bParada = bl.filter(b => b.parada_id === p.id);
      const ppParada = pp.filter(x => x.parada_id === p.id);
      return `
        <tr style="background:#f8fafc">
          <td colspan="4" style="padding:8px 10px;font-weight:900;color:#0b315f;font-size:11px;border:1px solid #e5e7eb;">
            ${p.orden}. ${p.nombre} ${p.hora_estimada ? `· ${p.hora_estimada}` : ""} 
            <span style="font-weight:400;color:#6b7280;">(${bParada.length}/${ppParada.length} embarcaron)</span>
          </td>
        </tr>
        ${ppParada.map(x => {
          const emb = bl.find(b => b.pasajero_id === x.pasajero_id && b.parada_id === p.id);
          return `<tr>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${x.pasajero?.nombre || `#${x.pasajero_id}`}</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;font-family:monospace;">${x.pasajero?.dni || "—"}</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:center;">
              <span style="font-weight:900;color:${emb ? "#16a34a" : "#dc2626"};">${emb ? "✅ Embarcó" : "❌ No se presentó"}</span>
            </td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;color:#6b7280;">${emb ? fmtTs(emb.timestamp) : "—"}</td>
          </tr>`;
        }).join("")}
      `;
    }).join("");

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Reporte de Servicio — ${fechaDoc}</title>
<style>
@page{size:A4;margin:20mm 15mm}
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0}
.header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #0b315f;padding-bottom:12px;margin-bottom:16px}
.logo-area h1{font-size:18px;font-weight:900;color:#0b315f;margin:0}
.logo-area p{color:#6b7280;font-size:11px;margin:2px 0 0}
.badge{padding:4px 12px;border-radius:20px;font-weight:900;font-size:11px;}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.grid4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:14px}
.box{border:1px solid #e5e7eb;border-radius:6px;padding:10px 14px}
.box-title{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;letter-spacing:0.8px;border-bottom:1px solid #f1f5f9;padding-bottom:5px;margin-bottom:8px}
.kpi{text-align:center;border-radius:8px;padding:10px}
.kpi .num{font-size:28px;font-weight:900;margin:4px 0}
.kpi .lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
table{width:100%;border-collapse:collapse;font-size:10.5px;margin-bottom:14px}
thead{background:#0b315f;color:white}
thead th{padding:7px 10px;text-align:left;font-size:10px;letter-spacing:0.3px}
.footer{border-top:1px solid #e5e7eb;padding-top:8px;text-align:center;font-size:9px;color:#9ca3af;margin-top:20px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="header">
  <div class="logo-area">
    <h1>AFA Tours Peru S.A.C.</h1>
    <p>RUC: 20602117091 · transporte@afatoursperu.com · 966 707 225</p>
  </div>
  <div style="text-align:right">
    <p style="font-weight:900;font-size:14px;color:#0b315f;margin:0">REPORTE DE SERVICIO</p>
    <p style="color:#6b7280;font-size:11px;margin:2px 0">Generado: ${new Date().toLocaleDateString("es-PE")} ${new Date().toLocaleTimeString("es-PE",{hour:"2-digit",minute:"2-digit"})}</p>
  </div>
</div>

<div class="grid2">
  <div class="box">
    <div class="box-title">Datos del servicio</div>
    <div style="margin:3px 0"><b>CLIENTE:</b> ${cliente?.empresa || cliente?.nombre}</div>
    <div style="margin:3px 0"><b>RUC:</b> ${cliente?.ruc || "—"}</div>
    <div style="margin:3px 0"><b>FECHA:</b> ${fechaDoc}</div>
    <div style="margin:3px 0"><b>HORA:</b> ${r.hora_servicio?.slice(0,5) || "—"}</div>
    <div style="margin:3px 0"><b>RUTA:</b> ${r.origen} → ${r.destino}</div>
  </div>
  <div class="box">
    <div class="box-title">Cumplimiento del servicio</div>
    <div style="display:flex;justify-content:space-between;margin:3px 0"><span>Pasajeros esperados</span><b>${totalEsperados}</b></div>
    <div style="display:flex;justify-content:space-between;margin:3px 0"><span>Pasajeros embarcados</span><b style="color:#16a34a">${totalEmbarcados}</b></div>
    <div style="display:flex;justify-content:space-between;margin:3px 0"><span>No se presentaron</span><b style="color:#dc2626">${noEmbarcaron.length}</b></div>
    <div style="margin-top:8px;height:8px;background:#fee2e2;border-radius:4px;overflow:hidden">
      <div style="height:100%;background:#16a34a;width:${pct}%;border-radius:4px"></div>
    </div>
    <p style="font-weight:900;font-size:16px;color:#0b315f;margin:6px 0 0">${pct}% de cumplimiento</p>
  </div>
</div>

<div class="box" style="margin-bottom:14px">
  <div class="box-title">Detalle de embarques por parada</div>
  <table>
    <thead><tr><th>Pasajero</th><th>DNI</th><th>Estado</th><th>Hora de embarque</th></tr></thead>
    <tbody>${filasPorParada || `<tr><td colspan="4" style="text-align:center;padding:12px;color:#9ca3af;">Sin datos de embarque registrados</td></tr>`}</tbody>
  </table>
</div>

${noEmbarcaron.length > 0 ? `
<div class="box" style="margin-bottom:14px;border-color:#fca5a5">
  <div class="box-title" style="color:#dc2626">⚠ Pasajeros que no se presentaron (${noEmbarcaron.length})</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
    ${noEmbarcaron.map(x => `<div style="background:#fff5f5;border-radius:6px;padding:6px 10px;font-size:10px">
      <b>${x.pasajero?.nombre || `#${x.pasajero_id}`}</b><br/><span style="color:#9ca3af">${x.pasajero?.dni || "Sin DNI"}</span>
    </div>`).join("")}
  </div>
</div>` : ""}

<div class="box">
  <div class="box-title">Firma de conformidad</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:16px">
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:6px;margin-top:30px;font-size:10px;color:#6b7280">
        <b>AFA Tours Peru S.A.C.</b><br/>Representante legal
      </div>
    </div>
    <div style="text-align:center">
      <div style="border-top:1px solid #333;padding-top:6px;margin-top:30px;font-size:10px;color:#6b7280">
        <b>${cliente?.empresa || cliente?.nombre}</b><br/>Responsable del servicio
      </div>
    </div>
  </div>
</div>

<div class="footer">📍 Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana - Lima &nbsp;|&nbsp; 📞 (01) 3453707 · 📱 966 707 225 &nbsp;|&nbsp; ✉️ transporte@afatoursperu.com</div>
<script>window.onload=()=>window.print()</script>
</body></html>`;

    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); }
  }

  // ─── LOADING ─────────────────────────────────────────────────────────────
  if (initing) return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.navy }}><div style={{ width: 36, height: 36, border: "4px solid rgba(255,255,255,0.3)", borderTop: "4px solid white", borderRadius: "50%", animation: "spin 1s linear infinite" }} /><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></div>;

  // ─── LOGIN ────────────────────────────────────────────────────────────────
  if (!cliente) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.white, fontFamily: "system-ui,sans-serif" }}>
      <div style={{ background: C.navy, padding: "52px 24px 40px", textAlign: "center" }}>
        <div style={{ width: 72, height: 72, background: "rgba(255,255,255,0.12)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, margin: "0 auto 16px" }}>🏢</div>
        <h1 style={{ color: "white", fontWeight: 900, fontSize: 22, margin: 0 }}>Portal Empresarial</h1>
        <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, marginTop: 6 }}>AFA Tours Peru · Seguimiento de servicios corporativos</p>
      </div>
      <div style={{ flex: 1, padding: "32px 24px", maxWidth: 440, margin: "0 auto", width: "100%", boxSizing: "border-box" as const }}>
        <p style={{ color: C.gray600, fontSize: 14, textAlign: "center", marginBottom: 24 }}>Ingresa tu RUC o nombre de empresa para acceder a tus reportes</p>
        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.gray600, textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 8 }}>RUC o Nombre de empresa</label>
        <input value={rucInput} onChange={e => { setRucInput(e.target.value); setLoginErr(""); }} onKeyDown={e => e.key === "Enter" && login()}
          placeholder="Ej: 20123456789 o Compañía Minera ABC"
          style={{ width: "100%", padding: "14px 18px", borderRadius: 16, border: `2px solid ${rucInput ? C.navy : C.gray200}`, fontSize: 15, fontWeight: 700, outline: "none", boxSizing: "border-box" as const, color: C.gray800, marginBottom: 12 }} />
        {loginErr && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "10px 16px", marginBottom: 12, textAlign: "center" }}><p style={{ color: C.red, fontSize: 13, fontWeight: 700, margin: 0 }}>⚠️ {loginErr}</p></div>}
        <button onClick={login} disabled={loginLoad || !rucInput.trim()}
          style={{ width: "100%", padding: "14px 0", borderRadius: 16, border: "none", background: rucInput ? C.navy : C.gray200, color: "white", fontSize: 15, fontWeight: 900, cursor: rucInput ? "pointer" : "not-allowed" }}>
          {loginLoad ? "Buscando..." : "Acceder al portal →"}
        </button>
        <div style={{ marginTop: 32, background: C.gray50, borderRadius: 16, padding: 20 }}>
          <p style={{ color: C.navy, fontWeight: 900, fontSize: 13, margin: "0 0 10px" }}>¿Qué puedo ver aquí?</p>
          {[["📊", "Dashboard con KPIs de todos tus servicios"], ["🚌", "Seguimiento en tiempo real del bus asignado hoy"], ["📋", "Reporte de embarque: quién subió y a qué hora"], ["📄", "Descarga de reportes en PDF para auditoría"]].map(([i, t]) => (
            <div key={t} style={{ display: "flex", gap: 10, marginBottom: 8 }}><span style={{ fontSize: 16 }}>{i}</span><p style={{ color: C.gray600, fontSize: 13, margin: 0 }}>{t}</p></div>
          ))}
        </div>
        <p style={{ textAlign: "center", color: C.gray400, fontSize: 12, marginTop: 20 }}>¿Problemas? <a href="tel:966707225" style={{ color: C.navy, fontWeight: 700 }}>966 707 225</a></p>
      </div>
    </div>
  );

  // ─── APP PORTAL ───────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: C.gray50, fontFamily: "system-ui,sans-serif" }}>

      {/* HEADER */}
      <div style={{ background: C.navy, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🏢</div>
          <div>
            <p style={{ color: "white", fontWeight: 900, fontSize: 14, margin: 0 }}>{cliente.empresa || cliente.nombre}</p>
            <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, margin: 0 }}>RUC: {cliente.ruc || "—"} · Portal Empresarial</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {servicioActivo && <div style={{ background: "rgba(22,163,74,0.25)", border: "1px solid #4ade80", borderRadius: 8, padding: "4px 10px" }}><p style={{ color: "#4ade80", fontSize: 11, fontWeight: 700, margin: 0 }}>● Servicio activo hoy</p></div>}
          <button onClick={() => { clearSession(); setCliente(null); }} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, padding: "5px 12px", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Salir</button>
        </div>
      </div>

      {/* NAV TABS */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.gray200}`, display: "flex", overflowX: "auto" as const }}>
        {([
          { id: "dashboard", icon: "📊", label: "Dashboard" },
          { id: "activos",   icon: "🚌", label: "En tiempo real", dot: !!servicioActivo },
          { id: "historial", icon: "📋", label: "Historial" },
          { id: "reporte",   icon: "📄", label: "Reportes", disabled: !reservaSel },
        ] as any[]).map(t => (
          <button key={t.id} onClick={() => !t.disabled && setTab(t.id as Tab)}
            style={{ padding: "12px 20px", border: "none", background: "none", cursor: t.disabled ? "not-allowed" : "pointer", borderBottom: `3px solid ${tab === t.id ? C.navy : "transparent"}`, color: tab === t.id ? C.navy : t.disabled ? C.gray200 : C.gray600, fontWeight: tab === t.id ? 900 : 600, fontSize: 13, whiteSpace: "nowrap" as const, display: "flex", alignItems: "center", gap: 6, position: "relative" as const }}>
            {t.icon} {t.label}
            {t.dot && <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, position: "absolute" as const, top: 10, right: 12 }} />}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, padding: 20, maxWidth: 1100, margin: "0 auto", width: "100%", boxSizing: "border-box" as const }}>

        {/* ════ DASHBOARD ════ */}
        {tab === "dashboard" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 20 }}>
            {/* KPIs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
              {[
                { label: "Servicios este mes", val: serviciosMes,  color: C.navy,  bg: "#eef3f8", icon: "🗓️" },
                { label: "Total servicios",    val: serviciosTotal, color: "#166534", bg: "#dcfce7", icon: "✅" },
                { label: "Gasto acumulado",    val: fmtSoles(gastosTotal), color: "#854d0e", bg: "#fef9c3", icon: "💰" },
                { label: "Puntualidad",        val: `${puntualidad}%`, color: "#1d4ed8", bg: "#dbeafe", icon: "⏱️" },
                { label: "Pasajeros log",      val: pasajerosTotal, color: "#6d28d9", bg: "#ede9fe", icon: "👥" },
              ].map(k => (
                <div key={k.label} style={{ background: k.bg, borderRadius: 16, padding: "16px 20px", border: `1px solid ${k.color}22` }}>
                  <p style={{ fontSize: 22, margin: "0 0 4px" }}>{k.icon}</p>
                  <p style={{ fontSize: 26, fontWeight: 900, color: k.color, margin: 0 }}>{k.val}</p>
                  <p style={{ fontSize: 11, color: k.color + "99", fontWeight: 700, textTransform: "uppercase" as const, margin: "4px 0 0", letterSpacing: 0.5 }}>{k.label}</p>
                </div>
              ))}
            </div>

            {/* Alerta servicio activo */}
            {servicioActivo && (
              <div style={{ background: "#f0fdf4", border: "2px solid #86efac", borderRadius: 16, padding: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 12 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.green, animation: "pulse 1s infinite" }} />
                      <p style={{ color: C.green, fontWeight: 900, fontSize: 15, margin: 0 }}>Servicio en curso hoy</p>
                    </div>
                    <p style={{ color: C.gray800, fontWeight: 700, fontSize: 16, margin: 0 }}>{servicioActivo.origen} → {servicioActivo.destino}</p>
                    <p style={{ color: C.gray600, fontSize: 13, margin: "4px 0 0" }}>🕐 {servicioActivo.hora_servicio?.slice(0,5)} · {fmtFecha(servicioActivo.fecha_servicio)}</p>
                    {gpsActual && <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>📡 Última señal: {fmtTs(gpsActual.timestamp)} · {gpsActual.velocidad} km/h</p>}
                  </div>
                  <button onClick={() => setTab("activos")} style={{ padding: "12px 24px", borderRadius: 14, border: "none", background: C.navy, color: "white", fontWeight: 900, fontSize: 14, cursor: "pointer" }}>
                    🗺️ Ver en mapa →
                  </button>
                </div>
              </div>
            )}

            {/* Últimos servicios */}
            <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.gray100}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <p style={{ fontWeight: 900, color: C.gray800, margin: 0 }}>Últimos servicios</p>
                <button onClick={() => setTab("historial")} style={{ color: C.navy, fontSize: 12, fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}>Ver todos →</button>
              </div>
              {reservas.slice(0, 5).map(r => {
                const est = { pendiente: { bg: "#fef9c3", c: "#854d0e" }, completado: { bg: "#dcfce7", c: "#166534" }, realizado: { bg: "#dcfce7", c: "#166534" }, cancelado: { bg: "#fee2e2", c: "#991b1b" }, confirmado: { bg: "#dbeafe", c: "#1d4ed8" } }[r.estado] || { bg: C.gray100, c: C.gray600 };
                return (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: `1px solid ${C.gray100}`, gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.origen} → {r.destino}</p>
                      <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>{fmtFecha(r.fecha_servicio)} · {r.hora_servicio?.slice(0,5) || "—"}</p>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: est.bg, color: est.c, flexShrink: 0 }}>{r.estado}</span>
                    <span style={{ color: C.navy, fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{fmtSoles(Number(r.precio_cliente))}</span>
                    <button onClick={() => cargarDetalleReserva(r)} style={{ padding: "6px 14px", borderRadius: 10, border: `1px solid ${C.navy}`, color: C.navy, fontSize: 11, fontWeight: 700, background: "none", cursor: "pointer", flexShrink: 0 }}>Reporte</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ════ EN TIEMPO REAL ════ */}
        {tab === "activos" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>
            {!servicioActivo ? (
              <div style={{ background: C.white, borderRadius: 20, padding: 48, textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ fontSize: 40, marginBottom: 12 }}>🚌</p>
                <p style={{ color: C.navy, fontWeight: 900, fontSize: 18, margin: 0 }}>Sin servicio activo hoy</p>
                <p style={{ color: C.gray400, fontSize: 14, marginTop: 6 }}>Los servicios activos aparecen aquí en tiempo real</p>
              </div>
            ) : (
              <>
                <div style={{ background: C.white, borderRadius: 16, padding: 20, boxShadow: "0 1px 8px rgba(0,0,0,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 12 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: C.green }} /><p style={{ color: C.green, fontWeight: 900, margin: 0, fontSize: 13 }}>EN RUTA</p></div>
                    <p style={{ color: C.navy, fontWeight: 900, fontSize: 18, margin: 0 }}>{servicioActivo.origen}</p>
                    <p style={{ color: C.gray600, fontSize: 14, margin: "2px 0 0" }}>→ {servicioActivo.destino}</p>
                  </div>
                  {gpsActual && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {[["🚀 Velocidad", `${gpsActual.velocidad} km/h`], ["📡 Última señal", fmtTs(gpsActual.timestamp)]].map(([l, v]) => (
                        <div key={l} style={{ background: C.gray50, borderRadius: 10, padding: "8px 14px" }}>
                          <p style={{ color: C.gray400, fontSize: 10, fontWeight: 700, margin: 0 }}>{l}</p>
                          <p style={{ color: C.navy, fontWeight: 900, fontSize: 15, margin: "2px 0 0" }}>{v}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Mapa */}
                <div style={{ height: 420, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                  <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
                  {!gpsActual && <div style={{ position: "absolute" as const, inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(248,250,252,0.9)" }}>
                    <p style={{ color: C.gray600, fontWeight: 700 }}>📡 Esperando señal GPS del conductor...</p>
                  </div>}
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ HISTORIAL ════ */}
        {tab === "historial" && (
          <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.gray100}` }}>
              <p style={{ fontWeight: 900, color: C.gray800, margin: 0 }}>Historial completo de servicios ({reservas.length})</p>
            </div>
            <div style={{ overflowX: "auto" as const }}>
              <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: C.gray50, borderBottom: `1px solid ${C.gray200}` }}>
                    {["Fecha", "Hora", "Ruta", "Estado", "Precio", "Reporte"].map(h => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: "left" as const, fontSize: 11, fontWeight: 700, color: C.gray500 || C.gray600, textTransform: "uppercase" as const, whiteSpace: "nowrap" as const }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reservas.map(r => {
                    const est = { pendiente: { bg: "#fef9c3", c: "#854d0e" }, completado: { bg: "#dcfce7", c: "#166534" }, realizado: { bg: "#dcfce7", c: "#166534" }, cancelado: { bg: "#fee2e2", c: "#991b1b" }, confirmado: { bg: "#dbeafe", c: "#1d4ed8" } }[r.estado] || { bg: C.gray100, c: C.gray600 };
                    return (
                      <tr key={r.id} style={{ borderBottom: `1px solid ${C.gray100}` }}>
                        <td style={{ padding: "12px 16px", fontWeight: 600, color: C.gray800 }}>{fmtFecha(r.fecha_servicio)}</td>
                        <td style={{ padding: "12px 16px", color: C.gray600 }}>{r.hora_servicio?.slice(0,5) || "—"}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <p style={{ fontWeight: 700, color: C.gray800, margin: 0, fontSize: 13 }}>{r.origen}</p>
                          <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>→ {r.destino}</p>
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: est.bg, color: est.c }}>{r.estado}</span>
                        </td>
                        <td style={{ padding: "12px 16px", fontWeight: 700, color: C.navy }}>{fmtSoles(Number(r.precio_cliente))}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <button onClick={() => cargarDetalleReserva(r)}
                            style={{ padding: "6px 14px", borderRadius: 10, border: `1px solid ${C.navy}`, color: C.navy, fontSize: 11, fontWeight: 700, background: "none", cursor: "pointer" }}>
                            📄 Ver
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ════ REPORTE ════ */}
        {tab === "reporte" && reservaSel && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>
            {/* Header reporte */}
            <div style={{ background: C.white, borderRadius: 16, padding: 20, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 12 }}>
                <div>
                  <p style={{ color: C.gray400, fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, margin: "0 0 6px" }}>Reporte de servicio</p>
                  <p style={{ color: C.navy, fontWeight: 900, fontSize: 20, margin: 0 }}>{reservaSel.origen} → {reservaSel.destino}</p>
                  <p style={{ color: C.gray600, fontSize: 13, margin: "4px 0 0" }}>{fmtFecha(reservaSel.fecha_servicio)} · {reservaSel.hora_servicio?.slice(0,5) || "—"}</p>
                </div>
                <button onClick={() => generarReportePDF(reservaSel)}
                  style={{ padding: "12px 24px", borderRadius: 14, border: "none", background: C.navy, color: "white", fontWeight: 900, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                  📄 Descargar PDF
                </button>
              </div>
            </div>

            {/* KPIs del reporte */}
            {(() => {
              const bl = boarding[reservaSel.id] || [];
              const pp = ppList[reservaSel.id] || [];
              const pct = pp.length > 0 ? Math.round((bl.length / pp.length) * 100) : 0;
              return (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
                  {[
                    { l: "Esperados", v: pp.length,                      c: C.navy,  bg: "#eef3f8" },
                    { l: "Embarcaron", v: bl.length,                     c: C.green, bg: "#dcfce7" },
                    { l: "No asistieron", v: pp.length - bl.length,      c: C.red,   bg: "#fee2e2" },
                    { l: "Cumplimiento", v: `${pct}%`,                   c: "#1d4ed8", bg: "#dbeafe" },
                    { l: "Paradas", v: (paradas[reservaSel.id] || []).length, c: "#854d0e", bg: "#fef9c3" },
                  ].map(k => (
                    <div key={k.l} style={{ background: k.bg, borderRadius: 14, padding: "14px 16px" }}>
                      <p style={{ fontSize: 24, fontWeight: 900, color: k.c, margin: 0 }}>{k.v}</p>
                      <p style={{ fontSize: 10, color: k.c + "99", fontWeight: 700, textTransform: "uppercase" as const, margin: "4px 0 0" }}>{k.l}</p>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Paradas + boarding por parada */}
            {(paradas[reservaSel.id] || []).length > 0 ? (
              (paradas[reservaSel.id] || []).map(p => {
                const bParada = (boarding[reservaSel.id] || []).filter(b => b.parada_id === p.id);
                const ppParada = (ppList[reservaSel.id] || []).filter(x => x.parada_id === p.id);
                const pct = ppParada.length > 0 ? Math.round((bParada.length / ppParada.length) * 100) : 0;
                return (
                  <div key={p.id} style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                    <div style={{ padding: "12px 20px", background: C.gray50, borderBottom: `1px solid ${C.gray100}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", background: p.estado === "completada" ? C.navy : C.gray200, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 900 }}>{p.orden}</div>
                        <div>
                          <p style={{ color: C.gray800, fontWeight: 900, fontSize: 14, margin: 0 }}>{p.nombre}</p>
                          {p.hora_estimada && <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>🕐 {p.hora_estimada}</p>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" as const }}>
                        <p style={{ color: C.navy, fontWeight: 900, fontSize: 16, margin: 0 }}>{bParada.length}/{ppParada.length}</p>
                        <p style={{ color: pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red, fontSize: 11, fontWeight: 700, margin: "2px 0 0" }}>{pct}% cumplimiento</p>
                      </div>
                    </div>
                    {ppParada.length > 0 ? (
                      <div style={{ overflowX: "auto" as const }}>
                        <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
                          <thead><tr style={{ background: "#f8fafc" }}>
                            {["Pasajero", "DNI", "Estado", "Hora embarque", "Método"].map(h => <th key={h} style={{ padding: "8px 16px", textAlign: "left" as const, fontSize: 10, fontWeight: 700, color: C.gray600, textTransform: "uppercase" as const, borderBottom: `1px solid ${C.gray200}` }}>{h}</th>)}
                          </tr></thead>
                          <tbody>
                            {ppParada.map(x => {
                              const emb = bParada.find(b => b.pasajero_id === x.pasajero_id);
                              return (
                                <tr key={x.id} style={{ borderBottom: `1px solid ${C.gray100}`, background: emb ? "#f0fdf4" : "#fff5f5" }}>
                                  <td style={{ padding: "10px 16px", fontWeight: 700, color: C.gray800 }}>{x.pasajero?.nombre || `#${x.pasajero_id}`}</td>
                                  <td style={{ padding: "10px 16px", fontFamily: "monospace", color: C.gray600 }}>{x.pasajero?.dni || "—"}</td>
                                  <td style={{ padding: "10px 16px" }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: emb ? "#dcfce7" : "#fee2e2", color: emb ? C.green : C.red }}>
                                      {emb ? "✅ Embarcó" : "❌ No asistió"}
                                    </span>
                                  </td>
                                  <td style={{ padding: "10px 16px", color: C.gray600 }}>{emb ? fmtTs(emb.timestamp) : "—"}</td>
                                  <td style={{ padding: "10px 16px", color: C.gray400, fontSize: 11 }}>{emb ? (emb.metodo === "qr" ? "📷 QR" : "Manual") : "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div style={{ padding: "20px", textAlign: "center", color: C.gray400, fontSize: 13 }}>Sin pasajeros asignados a esta parada</div>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ background: C.white, borderRadius: 16, padding: 32, textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ fontSize: 32, marginBottom: 8 }}>📋</p>
                <p style={{ color: C.navy, fontWeight: 700 }}>Sin paradas configuradas en este servicio</p>
                <p style={{ color: C.gray400, fontSize: 13 }}>Los datos de boarding aparecerán cuando se configuren los paraderos</p>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}