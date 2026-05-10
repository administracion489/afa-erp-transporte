"use client";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// ══════════════════════════════════════════════════════════════════════════════
// FLOTA DE COSTOS
// ══════════════════════════════════════════════════════════════════════════════

type VehCosto = {
  nombre: string; capacidad: number;
  comb1: string; rend1: number; pct1: number;
  comb2?: string; rend2?: number; pct2?: number;
  valorCompra: number; residual: number; vidaUtil: number; kmAnio: number;
  nNeumaticos: number; costoNeumatico: number; vidaNeumatico: number;
  mantenimientoKm: number; seguroAnual: number; soatAnual: number;
  revisionSemestral: number; permisosAnual: number; otrosFijosMensual: number;
  conductorDia: number;
};

const FLOTA: Record<string, VehCosto> = {
  AUTO_4:      { nombre:"Auto 4 pax Gasolina",       capacidad:4,  comb1:"Gasolina",rend1:42,  pct1:1,    valorCompra:80000,  residual:0.25,vidaUtil:5, kmAnio:45000,nNeumaticos:4, costoNeumatico:450, vidaNeumatico:40000,mantenimientoKm:0.25,seguroAnual:3000, soatAnual:300, revisionSemestral:150,permisosAnual:1000,otrosFijosMensual:250,conductorDia:120 },
  SUV_4:       { nombre:"SUV 4 pax Gasolina",         capacidad:4,  comb1:"Gasolina",rend1:35,  pct1:1,    valorCompra:130000, residual:0.25,vidaUtil:5, kmAnio:45000,nNeumaticos:4, costoNeumatico:650, vidaNeumatico:45000,mantenimientoKm:0.35,seguroAnual:4500, soatAnual:350, revisionSemestral:150,permisosAnual:1500,otrosFijosMensual:300,conductorDia:140 },
  SUV_6:       { nombre:"SUV 6 pax GLP",              capacidad:6,  comb1:"GLP",     rend1:28,  pct1:1,    valorCompra:136000, residual:0.24,vidaUtil:5, kmAnio:45000,nNeumaticos:4, costoNeumatico:650, vidaNeumatico:45000,mantenimientoKm:0.39,seguroAnual:4500, soatAnual:380, revisionSemestral:150,permisosAnual:1500,otrosFijosMensual:320,conductorDia:140 },
  MINIVAN_10:  { nombre:"Minivan 10 pax Diésel",      capacidad:10, comb1:"Diésel",  rend1:27,  pct1:1,    valorCompra:190000, residual:0.20,vidaUtil:6, kmAnio:52000,nNeumaticos:4, costoNeumatico:750, vidaNeumatico:50000,mantenimientoKm:0.55,seguroAnual:7000, soatAnual:550, revisionSemestral:220,permisosAnual:2200,otrosFijosMensual:400,conductorDia:180 },
  VAN_15:      { nombre:"Van 15 pax Diésel",          capacidad:15, comb1:"Diésel",  rend1:22,  pct1:1,    valorCompra:240000, residual:0.18,vidaUtil:7, kmAnio:55000,nNeumaticos:6, costoNeumatico:850, vidaNeumatico:55000,mantenimientoKm:0.70,seguroAnual:9000, soatAnual:700, revisionSemestral:300,permisosAnual:2800,otrosFijosMensual:500,conductorDia:220 },
  SPRINTER_17: { nombre:"Sprinter 17 pax Diésel",     capacidad:17, comb1:"Diésel",  rend1:19,  pct1:1,    valorCompra:300000, residual:0.18,vidaUtil:8, kmAnio:60000,nNeumaticos:6, costoNeumatico:1000,vidaNeumatico:60000,mantenimientoKm:0.85,seguroAnual:11000,soatAnual:800, revisionSemestral:380,permisosAnual:3200,otrosFijosMensual:600,conductorDia:240 },
  SPRINTER_20: { nombre:"Sprinter 20 pax Diésel",     capacidad:20, comb1:"Diésel",  rend1:17,  pct1:1,    valorCompra:360000, residual:0.18,vidaUtil:8, kmAnio:62000,nNeumaticos:6, costoNeumatico:1200,vidaNeumatico:60000,mantenimientoKm:0.95,seguroAnual:13000,soatAnual:900, revisionSemestral:380,permisosAnual:3800,otrosFijosMensual:700,conductorDia:260 },
  CUSTER_25:   { nombre:"Custer 25 pax Diésel",       capacidad:25, comb1:"Diésel",  rend1:14,  pct1:1,    valorCompra:430000, residual:0.16,vidaUtil:8, kmAnio:63000,nNeumaticos:6, costoNeumatico:1300,vidaNeumatico:62000,mantenimientoKm:1.10,seguroAnual:15000,soatAnual:1000,revisionSemestral:450,permisosAnual:4000,otrosFijosMensual:750,conductorDia:280 },
  MINIBUS_30:  { nombre:"Minibus 30 pax Diésel",      capacidad:30, comb1:"Diésel",  rend1:12,  pct1:1,    valorCompra:520000, residual:0.15,vidaUtil:9, kmAnio:65000,nNeumaticos:6, costoNeumatico:1500,vidaNeumatico:65000,mantenimientoKm:1.20,seguroAnual:18000,soatAnual:1200,revisionSemestral:550,permisosAnual:4800,otrosFijosMensual:850,conductorDia:300 },
  MINIBUS_35:  { nombre:"Minibus 35 pax Diésel",      capacidad:35, comb1:"Diésel",  rend1:10.5,pct1:1,    valorCompra:600000, residual:0.15,vidaUtil:9, kmAnio:68000,nNeumaticos:8, costoNeumatico:1700,vidaNeumatico:65000,mantenimientoKm:1.35,seguroAnual:21000,soatAnual:1400,revisionSemestral:550,permisosAnual:5500,otrosFijosMensual:1000,conductorDia:320 },
  BUS_45:      { nombre:"Bus 45 pax Diésel",          capacidad:45, comb1:"Diésel",  rend1:8.5, pct1:1,    valorCompra:850000, residual:0.12,vidaUtil:10,kmAnio:75000,nNeumaticos:10,costoNeumatico:2100,vidaNeumatico:70000,mantenimientoKm:1.80,seguroAnual:28000,soatAnual:1800,revisionSemestral:750,permisosAnual:8000,otrosFijosMensual:1250,conductorDia:380 },
  BUS_49:      { nombre:"Bus 49 pax Diésel",          capacidad:49, comb1:"Diésel",  rend1:7.8, pct1:1,    valorCompra:600000, residual:0.12,vidaUtil:10,kmAnio:78000,nNeumaticos:10,costoNeumatico:2300,vidaNeumatico:70000,mantenimientoKm:2.00,seguroAnual:32000,soatAnual:2000,revisionSemestral:750,permisosAnual:9000,otrosFijosMensual:0,   conductorDia:250 },
  BUS_50:      { nombre:"Bus 50 pax Diésel",          capacidad:50, comb1:"Diésel",  rend1:7.5, pct1:1,    valorCompra:650000, residual:0.12,vidaUtil:10,kmAnio:78000,nNeumaticos:10,costoNeumatico:2300,vidaNeumatico:70000,mantenimientoKm:2.00,seguroAnual:33000,soatAnual:2000,revisionSemestral:750,permisosAnual:9000,otrosFijosMensual:100,  conductorDia:260 },
};

const PRECIO_COMB: Record<string, number> = { Gasolina:18.0, Diésel:16.5, GLP:8.5, GNV:2.2 };
const IGV=0.18, OVERHEAD=0.10, RESERVA=0.05;

// Grupos de vehículos para la tabla comparativa
const GRUPOS = [
  { grupo:"Ligeros", color:"#6366f1", vehs:["AUTO_4","SUV_4","SUV_6"] },
  { grupo:"Vans",    color:"#0891b2", vehs:["MINIVAN_10","VAN_15"] },
  { grupo:"Buses",   color:"#0b315f", vehs:["SPRINTER_17","SPRINTER_20","CUSTER_25","MINIBUS_30","MINIBUS_35","BUS_45","BUS_49","BUS_50"] },
];

type Resultado = {
  // Costos
  costoCombustible: number; costoNeumaticos: number; costoMantenimiento: number;
  costoDeprec: number; costoFijosKm: number; reserva: number;
  costoVehiculo: number; costoConductor: number; costoDirectos: number;
  costoDirectoTotal: number; overhead: number; baseCosto: number; costoKm: number;
  // EVENTUAL — precios por viaje
  totalMin15: number; totalEst20: number; totalAlto25: number;
  sinIGV15: number; sinIGV20: number; sinIGV25: number;
  precioPax20: number;
  // FIJO — precios por día
  diaCosto: number; diaMin: number; diaEst: number; diaAlto: number;
  diaMinIGV: number; diaEstIGV: number; diaAltoIGV: number;
  mesEstIGV: number; // diaEstIGV × 26
};

function calcular(
  idVeh: string, km: number, dias: number, peajes: number, otros: number,
  pernocte: number, viaticos: number
): Resultado | null {
  const v = FLOTA[idVeh];
  if (!v) return null;

  // ── Costos variables por km ──
  const pc1 = PRECIO_COMB[v.comb1] || 0;
  const combKm = (pc1 / v.rend1) * v.pct1 + (v.comb2 && v.rend2 && v.pct2 ? ((PRECIO_COMB[v.comb2]||0)/v.rend2)*v.pct2 : 0);
  const costoCombustible   = combKm * km;
  const costoNeumaticos    = ((v.nNeumaticos * v.costoNeumatico) / v.vidaNeumatico) * km;
  const costoMantenimiento = v.mantenimientoKm * km;

  // ── Costos fijos prorrateados ──
  const deprecKm   = (v.valorCompra * (1 - v.residual)) / (v.vidaUtil * v.kmAnio);
  const costoDeprec = deprecKm * km;
  const costoFijosKm = ((v.seguroAnual + v.soatAnual + v.revisionSemestral*2 + v.permisosAnual + v.otrosFijosMensual*12) / v.kmAnio) * km;

  // ── Subtotales ──
  const subtotalVeh    = costoCombustible + costoNeumaticos + costoMantenimiento + costoDeprec + costoFijosKm;
  const reserva        = subtotalVeh * RESERVA;
  const costoVehiculo  = subtotalVeh + reserva;
  const costoConductor = v.conductorDia * dias;
  const costoDirectos  = peajes + otros;
  const costoDirectoTotal = costoVehiculo + costoConductor + costoDirectos;
  const overhead       = costoDirectoTotal * OVERHEAD;
  const baseCostoViaje = costoDirectoTotal + overhead;
  const costoKm        = costoDirectoTotal / Math.max(km, 1);

  // ── EVENTUAL: precio total del viaje (incluye pernocte y viáticos para multi-día) ──
  const extraMultidia = pernocte + viaticos;
  const baseEvt = baseCostoViaje + extraMultidia;
  const precio  = (margen: number) => baseEvt / (1 - margen);
  const final   = (margen: number) => precio(margen) * (1 + IGV);

  // ── FIJO: precio por día (el km es el km diario de la ruta) ──
  // El costo por día = costos del vehículo por km + conductor + overhead
  const diaCosto = baseCostoViaje; // ya calculado para 1 día (km = km diarios)
  const diaP     = (m: number) => diaCosto / (1 - m);
  const diaF     = (m: number) => diaP(m) * (1 + IGV);

  return {
    costoCombustible, costoNeumaticos, costoMantenimiento,
    costoDeprec, costoFijosKm, reserva, costoVehiculo,
    costoConductor, costoDirectos, costoDirectoTotal, overhead,
    baseCosto: baseCostoViaje, costoKm,
    // EVENTUAL
    totalMin15: final(0.15), totalEst20: final(0.20), totalAlto25: final(0.25),
    sinIGV15: precio(0.15), sinIGV20: precio(0.20), sinIGV25: precio(0.25),
    precioPax20: final(0.20) / (v.capacidad || 1),
    // FIJO
    diaCosto,
    diaMin:    diaP(0.15), diaEst:    diaP(0.20), diaAlto:    diaP(0.25),
    diaMinIGV: diaF(0.15), diaEstIGV: diaF(0.20), diaAltoIGV: diaF(0.25),
    mesEstIGV: diaF(0.20) * 26,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const fmt  = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
const fmtN = (n: number, d=0) => n.toLocaleString("es-PE", { minimumFractionDigits:d, maximumFractionDigits:d });

function esHorarioOficina() {
  const l = new Date(new Date().toLocaleString("en-US", { timeZone:"America/Lima" }));
  return l.getDay()>=1 && l.getDay()<=5 && l.getHours()>=8 && l.getHours()<18;
}

// ══════════════════════════════════════════════════════════════════════════════
// PÁGINA
// ══════════════════════════════════════════════════════════════════════════════

export default function CotizadorPage() {
  const router = useRouter();

  // Modo
  const [modo,       setModo]       = useState<"eventual"|"fijo">("eventual");

  // Inputs comunes
  const [idVeh,      setIdVeh]      = useState("BUS_49");
  const [km,         setKm]         = useState(80);
  const [peajes,     setPeajes]     = useState(24);
  const [otros,      setOtros]      = useState(0);
  const [origen,     setOrigen]     = useState("");
  const [destino,    setDestino]    = useState("");
  const [cliente,    setCliente]    = useState("");

  // EVENTUAL
  const [dias,       setDias]       = useState(1);
  const [pernocte,   setPernocte]   = useState(0);
  const [viaticos,   setViaticos]   = useState(0);
  const [tipoServEv, setTipoServEv] = useState("solo_ida");

  // FIJO
  const [tipoServFj, setTipoServFj] = useState("transporte_personal");

  // Envío
  const [enviando,   setEnviando]   = useState(false);
  const [enviado,    setEnviado]    = useState(false);
  const [errorEnv,   setErrorEnv]   = useState("");

  const enOficina = esHorarioOficina();
  const veh       = FLOTA[idVeh];

  const resultado = useMemo(
    () => calcular(idVeh, km, modo==="eventual"?dias:1, peajes, otros, pernocte, viaticos),
    [idVeh, km, dias, peajes, otros, pernocte, viaticos, modo]
  );

  // Comparativo toda la flota
  const comparativo = useMemo(() =>
    Object.entries(FLOTA).map(([id, v]) => ({
      id, v,
      r: calcular(id, km, modo==="eventual"?dias:1, peajes, otros, pernocte, viaticos),
    })),
    [km, dias, peajes, otros, pernocte, viaticos, modo]
  );

  async function enviarACotizaciones() {
    if (!resultado) return;
    setEnviando(true); setErrorEnv("");

    const payload: any = {
      origen:          origen.trim() || null,
      destino:         destino.trim() || null,
      tipo:            modo === "fijo" ? "transporte_personal" : "eventual",
      estado:          "pendiente",
      modo_servicio:   modo,
      tipo_servicio:   modo === "eventual" ? tipoServEv : tipoServFj,
      // Precio
      precio_cliente:  modo === "eventual" ? resultado.totalEst20 : resultado.diaEstIGV,
      costo_estimado:  resultado.baseCosto,
      margen_estimado: modo === "eventual"
        ? resultado.totalEst20 - resultado.baseCosto
        : resultado.diaEstIGV - resultado.diaCosto,
      // Campos pricing
      precio_cotizador:   modo === "eventual" ? resultado.totalEst20 : resultado.diaEstIGV,
      costo_cotizador:    resultado.baseCosto,
      margen_cotizador:   20,
      vehiculo_cotizador: veh?.nombre || null,
      modo_precio:        "cotizador",
      // Campos FIJO
      precio_dia:             modo === "fijo" ? resultado.diaEstIGV : null,
      precio_mes_estimado:    modo === "fijo" ? resultado.mesEstIGV : null,
      // Campos EVENTUAL
      dias_servicio:          modo === "eventual" ? dias : 1,
      horas_servicio:         8,
      pernocte_costo:         pernocte,
      observaciones: [
        cliente ? `Cliente: ${cliente}` : null,
        `Vehículo: ${veh?.nombre}`,
        `KM: ${km} km`,
        `Margen 20% | Modo: ${modo.toUpperCase()}`,
        modo === "fijo" ? `Precio/día: ${fmt(resultado.diaEstIGV)} | Mes est.: ${fmt(resultado.mesEstIGV)}` : `Total: ${fmt(resultado.totalEst20)}`,
      ].filter(Boolean).join(" | "),
    };

    const { error } = await supabase.from("cotizaciones").insert(payload);
    setEnviando(false);
    if (error) { setErrorEnv(error.message); return; }
    setEnviado(true);
    setTimeout(() => router.push("/cotizaciones"), 1800);
  }

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#eef3f8]">
      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-black text-[#0b315f]">Cotizador de Tarifas</h1>
            <p className="text-sm text-gray-400 mt-1">Estructura de costos operativos · Calcula precio real por vehículo</p>
          </div>
          <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold border ${enOficina?"bg-green-50 border-green-200 text-green-700":"bg-amber-50 border-amber-200 text-amber-700"}`}>
            <span>{enOficina?"🟢":"🟡"}</span>
            {enOficina ? "Horario de oficina — decisión manual" : "Fuera de horario — precio máximo automático"}
          </div>
        </div>

        {/* ── TOGGLE MODO ── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="grid grid-cols-2">
            {[
              { id:"eventual", label:"📋 EVENTUAL", sub:"Precio total por evento", color:"#0b315f", bg:"#eef3f8",
                desc:"Cotización / Orden de Servicio · Firma de conformidad" },
              { id:"fijo",     label:"📅 FIJO",     sub:"Precio por día · contratos", color:"#166534", bg:"#dcfce7",
                desc:"Contrato Mensual / Liquidación Semanal · Hoja de ruta diaria" },
            ].map(m => (
              <button key={m.id} onClick={() => setModo(m.id as any)}
                className="py-4 px-6 text-left border-b-4 transition-all"
                style={{
                  borderColor: modo === m.id ? m.color : "transparent",
                  background:  modo === m.id ? m.bg : "white",
                  color:       modo === m.id ? m.color : "#9ca3af",
                }}>
                <p className="font-black text-lg">{m.label}</p>
                <p className="text-sm font-bold opacity-80">{m.sub}</p>
                <p className="text-[11px] opacity-50 mt-1">{m.desc}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

          {/* ── PANEL INPUTS ── */}
          <div className="xl:col-span-1 space-y-4">

            {/* Datos del servicio */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-3">
              <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider">Datos del servicio</p>
              <input value={cliente} onChange={e => setCliente(e.target.value)} placeholder="Empresa cliente (opcional)"
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f]"/>
              <div className="grid grid-cols-2 gap-2">
                <input value={origen} onChange={e => setOrigen(e.target.value)} placeholder="Origen"
                  className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f]"/>
                <input value={destino} onChange={e => setDestino(e.target.value)} placeholder="Destino"
                  className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f]"/>
              </div>
            </div>

            {/* Tipo de servicio según modo */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider mb-3">
                Tipo de servicio — {modo === "eventual" ? "EVENTUAL" : "FIJO"}
              </p>
              {modo === "eventual" ? (
                <div className="space-y-1.5">
                  {[
                    { id:"solo_ida",            label:"➡️ Solo Ida",             sub:"Sin retorno" },
                    { id:"ida_retorno",          label:"⇄ Ida y Retorno",          sub:"Horarios cerrados" },
                    { id:"ida_retorno_paradas",  label:"📍 Con Paradas / Horas",   sub:"Disposición flexible" },
                    { id:"full_day",             label:"⭐ Full Day / Tour",        sub:"8-12 horas con itinerario" },
                    { id:"multi_dia",            label:"🏕️ Multi-día",             sub:"2+ días: pernocte + viáticos" },
                  ].map(s => (
                    <button key={s.id} onClick={() => setTipoServEv(s.id)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-left transition-all"
                      style={{ background: tipoServEv===s.id?"#eef3f8":"white", borderColor: tipoServEv===s.id?"#0b315f":"#e5e7eb", color: tipoServEv===s.id?"#0b315f":"#6b7280" }}>
                      <div>
                        <p className="font-bold text-sm">{s.label}</p>
                        <p className="text-[10px] opacity-60">{s.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {[
                    { id:"fijo_solo_ida",        label:"→ Solo Ida",          sub:"Solo entrada o solo salida" },
                    { id:"transporte_personal",  label:"⇄ Ida y Retorno",     sub:"Recojo y retorno fijos" },
                    { id:"fijo_multiparada",     label:"📍 Con Paraderos",     sub:"Multiparada — mayor desgaste" },
                    { id:"fijo_reten",           label:"🏭 Retén / Planta",    sub:"Unidad disponible 24h o turno" },
                  ].map(s => (
                    <button key={s.id} onClick={() => setTipoServFj(s.id)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-left transition-all"
                      style={{ background: tipoServFj===s.id?"#dcfce7":"white", borderColor: tipoServFj===s.id?"#166534":"#e5e7eb", color: tipoServFj===s.id?"#166534":"#6b7280" }}>
                      <div>
                        <p className="font-bold text-sm">{s.label}</p>
                        <p className="text-[10px] opacity-60">{s.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Vehículo */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider mb-3">🚌 Vehículo</p>
              <select value={idVeh} onChange={e => setIdVeh(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-semibold text-[#0b315f] outline-none focus:border-[#0b315f]">
                {Object.entries(FLOTA).map(([id, v]) => (
                  <option key={id} value={id}>{v.nombre} ({v.capacidad} pax)</option>
                ))}
              </select>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {veh && [
                  { label:"Capacidad",   val:`${veh.capacidad} pax` },
                  { label:"Combustible", val:veh.comb1 },
                  { label:"Rendimiento", val:`${veh.rend1} km/${veh.comb1==="GNV"?"m³":"gal"}` },
                  { label:"Costo Cond.", val:`S/ ${veh.conductorDia}/día` },
                ].map(i => (
                  <div key={i.label} className="bg-[#eef3f8] rounded-lg px-2.5 py-2">
                    <p className="text-[9px] font-bold text-gray-400 uppercase">{i.label}</p>
                    <p className="text-xs font-black text-[#0b315f] mt-0.5">{i.val}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Variables */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-4">
              <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider">
                Variables — {modo === "fijo" ? "km diarios de la ruta" : "km del servicio"}
              </p>

              {/* Km */}
              <div>
                <div className="flex justify-between mb-1.5">
                  <label className="text-xs font-bold text-gray-500">{modo==="fijo"?"Km diarios (ida+vuelta)":"Km totales del servicio"}</label>
                  <span className="text-xs font-black text-[#0b315f]">{km} km</span>
                </div>
                <input type="range" min={5} max={500} step={5} value={km} onChange={e => setKm(Number(e.target.value))}
                  className="w-full accent-[#0b315f]"/>
              </div>

              {/* Días conductor — solo EVENTUAL */}
              {modo === "eventual" && (
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                    Días de conductor
                  </label>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setDias(Math.max(1, dias-1))} className="w-9 h-9 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold text-gray-600">-</button>
                    <span className="flex-1 text-center font-black text-[#0b315f]">{dias} día{dias>1?"s":""}</span>
                    <button onClick={() => setDias(Math.min(30, dias+1))} className="w-9 h-9 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold text-gray-600">+</button>
                  </div>
                </div>
              )}

              {/* Peajes y otros */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label:"Peajes S/", val:peajes, set:setPeajes },
                  { label:"Otros S/",  val:otros,  set:setOtros  },
                ].map(f => (
                  <div key={f.label}>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">{f.label}</label>
                    <input type="number" value={f.val} onChange={e => f.set(Number(e.target.value))} min={0}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] text-center"/>
                  </div>
                ))}
              </div>

              {/* Multi-día: pernocte y viáticos */}
              {modo === "eventual" && tipoServEv === "multi_dia" && (
                <div className="rounded-xl bg-purple-50 border border-purple-200 p-3 space-y-3">
                  <p className="text-[10px] font-black text-purple-700 uppercase tracking-wider">🏕️ Costos multi-día</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label:"Pernocte bus S/",   val:pernocte, set:setPernocte },
                      { label:"Viáticos chofer S/", val:viaticos, set:setViaticos },
                    ].map(f => (
                      <div key={f.label}>
                        <label className="text-[10px] font-bold text-purple-600 uppercase block mb-1">{f.label}</label>
                        <input type="number" value={f.val} onChange={e => f.set(Number(e.target.value))} min={0}
                          className="w-full border border-purple-200 rounded-xl px-3 py-2 text-sm font-bold text-purple-700 outline-none focus:border-purple-400 text-center bg-white"/>
                      </div>
                    ))}
                  </div>
                  {(pernocte > 0 || viaticos > 0) && (
                    <p className="text-[10px] text-purple-600 font-bold">
                      Extras: {fmt(pernocte + viaticos)} → se suman al costo base
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── PANEL RESULTADOS ── */}
          <div className="xl:col-span-2 space-y-4">

            {resultado ? (
              <>
                {/* ── EVENTUAL: precio total ── */}
                {modo === "eventual" && (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label:"⛔ Mínimo (15%)",    val:resultado.totalMin15, sinIgv:resultado.sinIGV15, color:"#ef4444", bg:"#fef2f2", border:"#fecaca", margen:15 },
                        { label:"✅ Estándar (20%)",   val:resultado.totalEst20, sinIgv:resultado.sinIGV20, color:"#16a34a", bg:"#f0fdf4", border:"#86efac", margen:20 },
                        { label:"⭐ Premium (25%)",    val:resultado.totalAlto25, sinIgv:resultado.sinIGV25, color:"#6d28d9", bg:"#faf5ff", border:"#d8b4fe", margen:25 },
                      ].map(k => (
                        <div key={k.label} className="rounded-2xl p-4 border-2" style={{ background:k.bg, borderColor:k.border }}>
                          <p className="text-[10px] font-bold uppercase text-gray-400">{k.label}</p>
                          <p className="font-black text-xl mt-1" style={{ color:k.color }}>{fmt(k.val)}</p>
                          <p className="text-[11px] text-gray-400 mt-1">Sin IGV: {fmt(k.sinIgv)}</p>
                          {k.margen === 20 && (
                            <p className="text-[10px] text-green-600 font-bold mt-1">
                              S/ {fmtN(resultado.precioPax20)} / pax
                            </p>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Multi-día desglose */}
                    {tipoServEv === "multi_dia" && (pernocte > 0 || viaticos > 0) && (
                      <div className="bg-purple-50 border border-purple-200 rounded-2xl px-5 py-3 flex items-center gap-4">
                        <span className="text-2xl">🏕️</span>
                        <div>
                          <p className="font-black text-purple-700 text-sm">Incluye costos multi-día</p>
                          <p className="text-purple-600 text-xs">
                            Pernocte: {fmt(pernocte)} · Viáticos: {fmt(viaticos)} · Extra total: {fmt(pernocte+viaticos)}
                          </p>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* ── FIJO: precio por día + mes ── */}
                {modo === "fijo" && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label:"⛔ Día mínimo (15%)", val:resultado.diaMinIGV, dia:resultado.diaMin, color:"#ef4444", bg:"#fef2f2", border:"#fecaca" },
                        { label:"✅ Día estándar (20%)",val:resultado.diaEstIGV, dia:resultado.diaEst, color:"#16a34a", bg:"#f0fdf4", border:"#86efac" },
                        { label:"⭐ Día premium (25%)", val:resultado.diaAltoIGV,dia:resultado.diaAlto,color:"#6d28d9", bg:"#faf5ff", border:"#d8b4fe" },
                      ].map(k => (
                        <div key={k.label} className="rounded-2xl p-4 border-2" style={{ background:k.bg, borderColor:k.border }}>
                          <p className="text-[10px] font-bold uppercase text-gray-400">{k.label}</p>
                          <p className="font-black text-xl mt-1" style={{ color:k.color }}>{fmt(k.val)}</p>
                          <p className="text-[11px] text-gray-400 mt-1">Sin IGV: {fmt(k.dia)}</p>
                        </div>
                      ))}
                    </div>

                    {/* Estimado mensual destacado */}
                    <div className="rounded-2xl border-2 border-green-300 bg-green-50 p-5 flex items-center justify-between">
                      <div>
                        <p className="text-[11px] font-bold text-green-600 uppercase tracking-wider">Estimado mensual (20% margen × 26 días)</p>
                        <p className="font-black text-3xl text-green-700 mt-1">{fmt(resultado.mesEstIGV)}</p>
                        <p className="text-xs text-green-600 mt-1">
                          {fmt(resultado.diaEstIGV)}/día × 26 días hábiles = {fmt(resultado.mesEstIGV)}/mes
                        </p>
                      </div>
                      <div className="text-4xl">📅</div>
                    </div>

                    {/* Tabla por variante */}
                    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            {["Variante","Precio/día (sin IGV)","Precio/día (con IGV)","Estimado/mes (×26)"].map(h => (
                              <th key={h} className="px-4 py-3 text-left text-[11px] font-black text-gray-400 uppercase tracking-wide">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {[
                            { label:"Mínimo 15%",  dia:resultado.diaMin, diaF:resultado.diaMinIGV, mes:resultado.diaMinIGV*26, color:"#ef4444" },
                            { label:"Estándar 20%",dia:resultado.diaEst, diaF:resultado.diaEstIGV, mes:resultado.mesEstIGV,    color:"#16a34a" },
                            { label:"Premium 25%", dia:resultado.diaAlto,diaF:resultado.diaAltoIGV,mes:resultado.diaAltoIGV*26,color:"#6d28d9" },
                          ].map(row => (
                            <tr key={row.label} className="hover:bg-gray-50">
                              <td className="px-4 py-3 font-bold text-xs" style={{ color:row.color }}>{row.label}</td>
                              <td className="px-4 py-3 font-mono font-bold text-gray-700">{fmt(row.dia)}</td>
                              <td className="px-4 py-3 font-mono font-black" style={{ color:row.color }}>{fmt(row.diaF)}</td>
                              <td className="px-4 py-3 font-mono font-black text-gray-800">{fmt(row.mes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Desglose de costos */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-5 py-4 border-b">
                    <h2 className="font-black text-[#0b315f] text-sm">Desglose de costos operativos</h2>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {veh?.nombre} · {km} km{modo==="eventual"?" · "+dias+" día(s)":""} · {fmt(peajes)} peajes
                    </p>
                  </div>
                  <div className="p-5">
                    <div className="space-y-2">
                      {[
                        { label:`Combustible (${veh?.comb1})`,           val:resultado.costoCombustible,   pct:resultado.costoCombustible/resultado.costoDirectoTotal*100,   color:"#f97316" },
                        { label:`Neumáticos (${veh?.nNeumaticos} unid)`, val:resultado.costoNeumaticos,    pct:resultado.costoNeumaticos/resultado.costoDirectoTotal*100,    color:"#a78bfa" },
                        { label:"Mantenimiento preventivo",               val:resultado.costoMantenimiento, pct:resultado.costoMantenimiento/resultado.costoDirectoTotal*100, color:"#34d399" },
                        { label:"Depreciación",                           val:resultado.costoDeprec,        pct:resultado.costoDeprec/resultado.costoDirectoTotal*100,        color:"#60a5fa" },
                        { label:"Seguros, SOAT, revisiones, permisos",   val:resultado.costoFijosKm,       pct:resultado.costoFijosKm/resultado.costoDirectoTotal*100,       color:"#f87171" },
                        { label:"Reserva imprevistos (5%)",              val:resultado.reserva,            pct:resultado.reserva/resultado.costoDirectoTotal*100,            color:"#94a3b8" },
                        { label:`Conductor (${fmt(veh?.conductorDia||0)}/día)`, val:resultado.costoConductor, pct:resultado.costoConductor/resultado.costoDirectoTotal*100, color:"#fb923c" },
                        { label:"Peajes y otros directos",               val:resultado.costoDirectos,      pct:resultado.costoDirectos/resultado.costoDirectoTotal*100,      color:"#94a3b8" },
                      ].map(item => (
                        <div key={item.label} className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-gray-500 truncate">{item.label}</p>
                            <div className="h-1.5 rounded-full bg-gray-100 mt-1 overflow-hidden">
                              <div className="h-full rounded-full" style={{ width:`${Math.min(item.pct,100)}%`, background:item.color }}/>
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0 w-24">
                            <p className="text-xs font-bold text-[#0b315f]">{fmt(item.val)}</p>
                            <p className="text-[9px] text-gray-300">{item.pct>0.1?`${item.pct.toFixed(1)}%`:""}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      {[
                        { label:"Costo directo total",  val:resultado.costoDirectoTotal, bold:false },
                        { label:"Overhead admin (10%)", val:resultado.overhead,          bold:false },
                        { label:"Base costo completo",  val:resultado.baseCosto,         bold:true  },
                        { label:"Costo S/km",           val:`${fmtN(resultado.costoKm,2)}/km`, bold:false, texto:true },
                      ].map(row => (
                        <div key={row.label} className={`flex justify-between items-center px-3 py-2 rounded-xl ${row.bold?"bg-[#eef3f8]":"bg-gray-50"}`}>
                          <span className={`text-xs ${row.bold?"font-black text-[#0b315f]":"text-gray-500 font-semibold"}`}>{row.label}</span>
                          <span className={`text-sm ${row.bold?"font-black text-[#0b315f]":"font-bold text-gray-600"}`}>
                            {row.texto ? `S/ ${row.val}` : fmt(row.val as number)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Panel enviar a cotizaciones */}
                <div className="rounded-2xl border-2 overflow-hidden"
                  style={{ background: enviado?"#f0fdf4":"#0b315f", borderColor: enviado?"#86efac":"#0b315f" }}>
                  {enviado ? (
                    <div className="p-6 text-center">
                      <p className="text-3xl mb-2">✅</p>
                      <p className="font-black text-green-700 text-base">Cotización creada exitosamente</p>
                      <p className="text-green-600 text-sm mt-1">Redirigiendo a Cotizaciones...</p>
                    </div>
                  ) : (
                    <div className="p-5">
                      <h3 className="font-black text-white text-base mb-1">
                        → Enviar a Cotizaciones
                      </h3>
                      <p className="text-white/60 text-xs mb-4">
                        {modo === "fijo"
                          ? `Se creará una cotización FIJA con precio/día de ${fmt(resultado.diaEstIGV)} y estimado mensual de ${fmt(resultado.mesEstIGV)}`
                          : `Se creará una cotización EVENTUAL con precio total de ${fmt(resultado.totalEst20)} (margen 20%)`
                        }
                      </p>

                      {/* Resumen */}
                      <div className="grid grid-cols-3 gap-3 mb-4">
                        {(modo === "eventual" ? [
                          { label:"Costo base",   val:fmt(resultado.baseCosto),  color:"#fca5a5" },
                          { label:"Sin IGV",      val:fmt(resultado.sinIGV20),   color:"#fcd34d" },
                          { label:"Precio final", val:fmt(resultado.totalEst20), color:"#6ee7b7" },
                        ] : [
                          { label:"Precio/día",   val:fmt(resultado.diaEstIGV), color:"#6ee7b7" },
                          { label:"Mes est.",     val:fmt(resultado.mesEstIGV), color:"#a78bfa" },
                          { label:"Costo/día",    val:fmt(resultado.baseCosto), color:"#fca5a5" },
                        ]).map(k => (
                          <div key={k.label} className="bg-white/10 rounded-xl p-3 text-center">
                            <p className="text-white/50 text-[10px] font-bold uppercase">{k.label}</p>
                            <p className="font-black text-sm mt-0.5" style={{ color:k.color }}>{k.val}</p>
                          </div>
                        ))}
                      </div>

                      {!origen || !destino ? (
                        <div className="grid grid-cols-2 gap-2 mb-4">
                          <input value={origen} onChange={e => setOrigen(e.target.value)} placeholder="Origen"
                            className="bg-white/10 border border-white/20 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 outline-none focus:border-white/40"/>
                          <input value={destino} onChange={e => setDestino(e.target.value)} placeholder="Destino"
                            className="bg-white/10 border border-white/20 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 outline-none focus:border-white/40"/>
                        </div>
                      ) : null}

                      {errorEnv && <p className="text-red-300 text-xs font-semibold bg-red-500/20 rounded-xl px-3 py-2 mb-3">⚠ {errorEnv}</p>}

                      <button onClick={enviarACotizaciones} disabled={enviando}
                        className="w-full py-3.5 rounded-xl font-black text-sm bg-white text-[#0b315f] hover:bg-gray-100 disabled:opacity-50 transition-all">
                        {enviando ? "Creando cotización..." : `→ Crear cotización ${modo.toUpperCase()} — ${modo==="eventual"?fmt(resultado.totalEst20):fmt(resultado.diaEstIGV)+"/día"}`}
                      </button>
                    </div>
                  )}
                </div>

                {/* Tabla comparativa toda la flota */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-5 py-4 border-b">
                    <h2 className="font-black text-[#0b315f] text-sm">
                      Comparativo toda la flota — {modo==="eventual"?"precio total":"precio por día"}
                    </h2>
                    <p className="text-xs text-gray-400 mt-0.5">{km} km · margen 20%</p>
                  </div>
                  <div className="overflow-x-auto">
                    {GRUPOS.map(g => (
                      <div key={g.grupo}>
                        <div className="px-4 py-2 text-[10px] font-black uppercase tracking-wider border-b"
                          style={{ background: g.color+"15", color: g.color }}>
                          {g.grupo}
                        </div>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-gray-50 border-b">
                              {["Vehículo","Cap.","Costo base",
                                modo==="eventual"?"Precio total (20%)":"Precio/día (20%)",
                                modo==="eventual"?"S/pax":"Mes est. (×26)",
                                "Mínimo (15%)","Estado"
                              ].map(h => (
                                <th key={h} className="px-3 py-2 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {g.vehs.map(vid => {
                              const item = comparativo.find(c => c.id === vid);
                              if (!item?.r) return null;
                              const r   = item.r;
                              const act = vid === idVeh;
                              const precPpal = modo==="eventual" ? r.totalEst20 : r.diaEstIGV;
                              const precSec  = modo==="eventual" ? r.precioPax20 : r.mesEstIGV;
                              const precMin  = modo==="eventual" ? r.totalMin15  : r.diaMinIGV;
                              return (
                                <tr key={vid} onClick={() => setIdVeh(vid)}
                                  className={`cursor-pointer transition-colors ${act?"bg-blue-50 border-l-2 border-l-[#0b315f]":"hover:bg-gray-50"}`}>
                                  <td className="px-3 py-2.5">
                                    <span className={`text-xs ${act?"font-black text-[#0b315f]":"font-semibold text-gray-600"}`}>
                                      {FLOTA[vid]?.nombre || vid}
                                    </span>
                                    {act && <span className="ml-1.5 text-[9px] font-black bg-[#0b315f] text-white px-1.5 py-0.5 rounded">SEL</span>}
                                  </td>
                                  <td className="px-3 py-2.5 text-xs font-bold text-gray-500">{FLOTA[vid]?.capacidad}p</td>
                                  <td className="px-3 py-2.5 text-xs text-gray-500 font-mono">{fmt(r.baseCosto)}</td>
                                  <td className="px-3 py-2.5 text-xs font-black text-[#0b315f] font-mono">{fmt(precPpal)}</td>
                                  <td className="px-3 py-2.5 text-xs font-bold text-gray-500 font-mono">
                                    {modo==="eventual" ? `S/ ${fmtN(precSec)}` : fmt(precSec)}
                                  </td>
                                  <td className="px-3 py-2.5 text-xs text-amber-600 font-mono">{fmt(precMin)}</td>
                                  <td className="px-3 py-2.5">
                                    <span className="text-[10px] font-black text-green-600">✓ OK</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
                <p className="text-gray-300 text-4xl mb-3">⚡</p>
                <p className="text-gray-400 font-semibold">Selecciona un vehículo para calcular</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}