"use client";
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ══════════════════════════════════════════════════════════════════════════════
// MOTOR DE COSTOS EN TIEMPO REAL
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

const FLOTA_COSTOS: Record<string, VehCosto> = {
  AUTO_4:      { nombre:"Auto 4 pax",      capacidad:4,  comb1:"Gasolina",rend1:42,  pct1:1, valorCompra:80000,  residual:0.25,vidaUtil:5, kmAnio:45000,nNeumaticos:4, costoNeumatico:450, vidaNeumatico:40000,mantenimientoKm:0.25,seguroAnual:3000, soatAnual:300, revisionSemestral:150,permisosAnual:1000,otrosFijosMensual:250,conductorDia:120 },
  SUV_4:       { nombre:"SUV 4 pax",        capacidad:4,  comb1:"Gasolina",rend1:35,  pct1:1, valorCompra:130000, residual:0.25,vidaUtil:5, kmAnio:45000,nNeumaticos:4, costoNeumatico:650, vidaNeumatico:45000,mantenimientoKm:0.35,seguroAnual:4500, soatAnual:350, revisionSemestral:150,permisosAnual:1500,otrosFijosMensual:300,conductorDia:140 },
  SUV_6:       { nombre:"SUV 6 pax",        capacidad:6,  comb1:"GLP",     rend1:28,  pct1:1, valorCompra:136000, residual:0.24,vidaUtil:5, kmAnio:45000,nNeumaticos:4, costoNeumatico:650, vidaNeumatico:45000,mantenimientoKm:0.39,seguroAnual:4500, soatAnual:380, revisionSemestral:150,permisosAnual:1500,otrosFijosMensual:320,conductorDia:140 },
  MINIVAN_10:  { nombre:"Minivan 10 pax",   capacidad:10, comb1:"Diésel",  rend1:27,  pct1:1, valorCompra:190000, residual:0.20,vidaUtil:6, kmAnio:52000,nNeumaticos:4, costoNeumatico:750, vidaNeumatico:50000,mantenimientoKm:0.55,seguroAnual:7000, soatAnual:550, revisionSemestral:220,permisosAnual:2200,otrosFijosMensual:400,conductorDia:180 },
  VAN_15:      { nombre:"Van 15 pax",       capacidad:15, comb1:"Diésel",  rend1:22,  pct1:1, valorCompra:240000, residual:0.18,vidaUtil:7, kmAnio:55000,nNeumaticos:6, costoNeumatico:850, vidaNeumatico:55000,mantenimientoKm:0.70,seguroAnual:9000, soatAnual:700, revisionSemestral:300,permisosAnual:2800,otrosFijosMensual:500,conductorDia:220 },
  SPRINTER_17: { nombre:"Sprinter 17 pax",  capacidad:17, comb1:"Diésel",  rend1:19,  pct1:1, valorCompra:300000, residual:0.18,vidaUtil:8, kmAnio:60000,nNeumaticos:6, costoNeumatico:1000,vidaNeumatico:60000,mantenimientoKm:0.85,seguroAnual:11000,soatAnual:800, revisionSemestral:380,permisosAnual:3200,otrosFijosMensual:600,conductorDia:240 },
  SPRINTER_20: { nombre:"Sprinter 20 pax",  capacidad:20, comb1:"Diésel",  rend1:17,  pct1:1, valorCompra:360000, residual:0.18,vidaUtil:8, kmAnio:62000,nNeumaticos:6, costoNeumatico:1200,vidaNeumatico:60000,mantenimientoKm:0.95,seguroAnual:13000,soatAnual:900, revisionSemestral:380,permisosAnual:3800,otrosFijosMensual:700,conductorDia:260 },
  CUSTER_25:   { nombre:"Custer 25 pax",    capacidad:25, comb1:"Diésel",  rend1:14,  pct1:1, valorCompra:430000, residual:0.16,vidaUtil:8, kmAnio:63000,nNeumaticos:6, costoNeumatico:1300,vidaNeumatico:62000,mantenimientoKm:1.10,seguroAnual:15000,soatAnual:1000,revisionSemestral:450,permisosAnual:4000,otrosFijosMensual:750,conductorDia:280 },
  MINIBUS_30:  { nombre:"Minibus 30 pax",   capacidad:30, comb1:"Diésel",  rend1:12,  pct1:1, valorCompra:520000, residual:0.15,vidaUtil:9, kmAnio:65000,nNeumaticos:6, costoNeumatico:1500,vidaNeumatico:65000,mantenimientoKm:1.20,seguroAnual:18000,soatAnual:1200,revisionSemestral:550,permisosAnual:4800,otrosFijosMensual:850,conductorDia:300 },
  MINIBUS_35:  { nombre:"Minibus 35 pax",   capacidad:35, comb1:"Diésel",  rend1:10.5,pct1:1, valorCompra:600000, residual:0.15,vidaUtil:9, kmAnio:68000,nNeumaticos:8, costoNeumatico:1700,vidaNeumatico:65000,mantenimientoKm:1.35,seguroAnual:21000,soatAnual:1400,revisionSemestral:550,permisosAnual:5500,otrosFijosMensual:1000,conductorDia:320 },
  BUS_45:      { nombre:"Bus 45 pax",       capacidad:45, comb1:"Diésel",  rend1:8.5, pct1:1, valorCompra:850000, residual:0.12,vidaUtil:10,kmAnio:75000,nNeumaticos:10,costoNeumatico:2100,vidaNeumatico:70000,mantenimientoKm:1.80,seguroAnual:28000,soatAnual:1800,revisionSemestral:750,permisosAnual:8000,otrosFijosMensual:1250,conductorDia:380 },
  BUS_49:      { nombre:"Bus 49 pax",       capacidad:49, comb1:"Diésel",  rend1:7.8, pct1:1, valorCompra:600000, residual:0.12,vidaUtil:10,kmAnio:78000,nNeumaticos:10,costoNeumatico:2300,vidaNeumatico:70000,mantenimientoKm:2.00,seguroAnual:32000,soatAnual:2000,revisionSemestral:750,permisosAnual:9000,otrosFijosMensual:0,   conductorDia:250 },
  BUS_50:      { nombre:"Bus 50 pax",       capacidad:50, comb1:"Diésel",  rend1:7.5, pct1:1, valorCompra:650000, residual:0.12,vidaUtil:10,kmAnio:78000,nNeumaticos:10,costoNeumatico:2300,vidaNeumatico:70000,mantenimientoKm:2.00,seguroAnual:33000,soatAnual:2000,revisionSemestral:750,permisosAnual:9000,otrosFijosMensual:100,  conductorDia:260 },
};

const PRECIO_COMB: Record<string,number> = { Gasolina:18, Diésel:16.5, GLP:8.5, GNV:2.2 };
const IGV=0.18, OVERHEAD=0.10, RESERVA=0.05;

type ResultCosto = {
  baseCosto: number;
  totalMin15: number; totalEst20: number; totalAlto25: number;
  sinIGV15: number;  sinIGV20: number;  sinIGV25: number;
  precioPax20: number;
  diaEstIGV: number; mesEstIGV: number; diaMin: number; diaEst: number;
};

function calcCosto(idVeh:string, km:number, dias:number, peajes:number, pernocte:number, viaticos:number): ResultCosto|null {
  const v = FLOTA_COSTOS[idVeh]; if (!v) return null;
  const pc = PRECIO_COMB[v.comb1]||0;
  const combKm = (pc/v.rend1)*v.pct1 + (v.comb2&&v.rend2&&v.pct2?((PRECIO_COMB[v.comb2]||0)/v.rend2)*v.pct2:0);
  const cComb  = combKm*km;
  const cNeum  = ((v.nNeumaticos*v.costoNeumatico)/v.vidaNeumatico)*km;
  const cMant  = v.mantenimientoKm*km;
  const dKm    = (v.valorCompra*(1-v.residual))/(v.vidaUtil*v.kmAnio);
  const cDepr  = dKm*km;
  const cFij   = ((v.seguroAnual+v.soatAnual+v.revisionSemestral*2+v.permisosAnual+v.otrosFijosMensual*12)/v.kmAnio)*km;
  const sub    = cComb+cNeum+cMant+cDepr+cFij;
  const res    = sub*RESERVA;
  const cVeh   = sub+res;
  const cCond  = v.conductorDia*dias;
  const cDir   = peajes;
  const total  = cVeh+cCond+cDir;
  const oh     = total*OVERHEAD;
  const base   = total+oh+pernocte+viaticos;
  const p      = (m:number) => base/(1-m);
  const f      = (m:number) => p(m)*(1+IGV);
  const dBase  = (cVeh+cCond+cDir+oh);
  const dEst   = dBase/(1-0.20)*(1+IGV);
  return {
    baseCosto: base,
    totalMin15: f(0.15), totalEst20: f(0.20), totalAlto25: f(0.25),
    sinIGV15: p(0.15), sinIGV20: p(0.20), sinIGV25: p(0.25),
    precioPax20: f(0.20)/(v.capacidad||1),
    diaEst: dBase/(1-0.20), diaEstIGV: dEst,
    diaMin: dBase/(1-0.15), mesEstIGV: dEst*26,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS ERP
// ══════════════════════════════════════════════════════════════════════════════

type EstadoCot = "pendiente"|"enviado"|"aprobado"|"rechazado";
type ModoServ  = "eventual"|"fijo";
type ItemCot   = { descripcion:string; dias:number; cantidad:number; precio_unit:number; descuento_pct:number; };
type ConsidCot = { incluye:string[]; no_incluye:string[]; generales:string[]; };

type Cliente = {
  id:number; nombre:string; empresa?:string; tipo?:string;
  ruc?:string; dni?:string; telefono?:string; email?:string;
  direccion?:string; estado?:string;
  operativo_nombre?:string; administrativo_nombre?:string;
};

type Cotizacion = {
  id:number; cliente_id:number|null;
  origen:string; destino:string; km:number;
  precio_cliente:number; costo_estimado:number; margen_estimado:number;
  estado:EstadoCot; numero_cotizacion:string|null; atencion:string|null;
  asunto:string|null; punto_retorno:string|null;
  fecha_servicio:string|null; hora_ida:string|null; hora_retorno:string|null;
  descuento_pct:number; items_json:ItemCot[]|null;
  numero_aprobacion:string|null; tipo_aprobacion:string|null;
  tipo_vehiculo:string|null; tipo_servicio:string|null;
  equipamiento:string|null; vehiculo_flota_id:number|null;
  consideraciones_json:ConsidCot|null; paradas_json:ParadaTP[]|null;
  created_at:string;
  modo_servicio:ModoServ|null;
  dias_servicio:number|null; horas_servicio:number|null;
  pernocte_costo:number|null;
  precio_dia:number|null; precio_mes_estimado:number|null;
  precio_tarifario:number|null; precio_cotizador:number|null;
  costo_cotizador:number|null; margen_cotizador:number|null;
  vehiculo_cotizador:string|null; precio_sugerido:number|null;
  modo_precio:string|null; enviado_automatico:boolean;
  descuento_solicitado:boolean; descuento_pct_solicitado:number|null;
  descuento_autorizado:boolean; hora_solicitud_descuento:string|null;
};

type ParadaTP = { id:string; tipo:"inicio"|"intermedia"|"destino"; nombre:string; direccion:string; lat:string; lng:string; hora:string; };

type Tarifa = {
  id:number; origen:string; destino:string;
  tipo_vehiculo:string; equipamiento:string; tipo_servicio:string; modo:string;
  precio:number; moneda:string; confidencial:boolean;
  incluye_guia:boolean; incluye_peajes:boolean; incluye_alimentacion:boolean;
  notas:string|null;
};

type VehiculoFlota = {
  id:number; placa:string; categoria:string|null; marca:string|null; modelo:string|null;
  anio:number|null; capacidad_pasajeros:number|null; equipamiento:string|null;
  foto_externa_url:string|null; foto_interna_url:string|null; descripcion_unidad:string|null;
};

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONSID: ConsidCot = {
  incluye: ["Traslado de origen a destino","Conductor profesional certificado","Combustible durante todo el recorrido","GPS en tiempo real","Seguro de viaje SOAT vigente"],
  no_incluye: ["Alimentación y bebidas","Guía turístico","Entradas a atractivos turísticos","Peajes (salvo indicación expresa en cotización)"],
  generales: ["Precios según fechas y horarios coordinados.","Tolerancia máxima de espera: 30 minutos.","No se permite consumo de alcohol ni tabaco a bordo.","Cambios en ruta u horario pueden generar costos adicionales.","Servicio eventual: adelanto del 50% para confirmar, saldo antes de culminar el servicio.","Recomendamos reservar con 7 días de anticipación mínimo."],
};

const TIPOS_VEH = [
  {id:"AUTO_4",icon:"🚗",label:"Auto 4p"},{id:"SUV_4",icon:"🚙",label:"SUV 4p"},
  {id:"SUV_6",icon:"🚙",label:"SUV 6p"},{id:"MINIVAN_10",icon:"🚐",label:"Minivan 10p"},
  {id:"VAN_15",icon:"🚐",label:"Van 15p"},{id:"SPRINTER_17",icon:"🚌",label:"Sprinter 17p"},
  {id:"SPRINTER_20",icon:"🚌",label:"Sprinter 20p"},{id:"CUSTER_25",icon:"🚌",label:"Custer 25p"},
  {id:"MINIBUS_30",icon:"🚌",label:"Minibus 30p"},{id:"MINIBUS_35",icon:"🚌",label:"Minibus 35p"},
  {id:"BUS_45",icon:"🚌",label:"Bus 45p"},{id:"BUS_49",icon:"🚌",label:"Bus 49p"},
  {id:"BUS_50",icon:"🚌",label:"Bus 50p"},
];

const SERVS_EVENTUAL = [
  {id:"solo_ida",           label:"➡️ Solo Ida",           cat:"Traslados"},
  {id:"ida_retorno",        label:"⇄ Ida y Retorno",        cat:"Traslados"},
  {id:"ida_retorno_paradas",label:"📍 Con Paradas / Horas", cat:"Disposición"},
  {id:"full_day",           label:"⭐ Full Day / Tour",      cat:"Turismo"},
  {id:"multi_dia",          label:"🏕️ Multi-día",           cat:"Turismo"},
];

const SERVS_FIJO = [
  {id:"fijo_solo_ida",       label:"→ Solo Ida",         cat:"Ruta Simple"},
  {id:"transporte_personal", label:"⇄ Ida y Retorno",    cat:"Ruta Simple"},
  {id:"fijo_multiparada",    label:"📍 Con Paraderos",    cat:"Ruta Logística"},
  {id:"fijo_reten",          label:"🏭 Retén / Planta",   cat:"Retén"},
];

const ESTADO_CFG: Record<EstadoCot,{label:string;bg:string;color:string}> = {
  pendiente:{label:"Pendiente",bg:"#fef9c3",color:"#854d0e"},
  enviado:  {label:"Enviado",  bg:"#e0f2fe",color:"#0369a1"},
  aprobado: {label:"Aprobado", bg:"#dcfce7",color:"#166534"},
  rechazado:{label:"Rechazado",bg:"#fee2e2",color:"#991b1b"},
};

const TIPOS_APROBACION = ["Operación bancaria","Orden de compra","Orden de servicio","Correo de confirmación","Contrato firmado"];
const ITEM_VACIO: ItemCot = {descripcion:"",dias:1,cantidad:1,precio_unit:0,descuento_pct:0};

const FORM0 = {
  cliente_id:"", origen:"", destino:"", km:"",
  costo_estimado:"", estado:"pendiente" as EstadoCot,
  numero_cotizacion:"", atencion:"", asunto:"",
  punto_retorno:"", fecha_servicio:"", hora_ida:"", hora_retorno:"",
  descuento_pct:"0",
  tipo_vehiculo:"BUS_49", equipamiento:"full_equipo", vehiculo_flota_id:"",
  modo_servicio:"eventual" as ModoServ,
  tipo_servicio:"solo_ida",
  dias_servicio:"1", horas_servicio:"8",
  pernocte_costo:"0", precio_dia:"",
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const fmtS = (n:number) => `S/ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtF = (f:string|null) => f?new Date(f+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}):"—";
const calcItems = (items:ItemCot[]) => { const s=items.reduce((t,it)=>t+it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100),0); return{subtotal:s,igv:s*0.18,total:s*1.18}; };
const norm = (s:string) => s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const iCls = (e="") => `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${e}`;
const driveImg = (url:string) => { const m=url?.match(/\/d\/([a-zA-Z0-9_-]{20,})/); return m?`https://drive.google.com/thumbnail?id=${m[1]}&sz=w800`:url; };
const enHorario = () => { const l=new Date(new Date().toLocaleString("en-US",{timeZone:"America/Lima"})); return l.getDay()>=1&&l.getDay()<=5&&l.getHours()>=8&&l.getHours()<18; };

function Campo({label,span,req,hint,children}:{label:string;span?:number;req?:boolean;hint?:string;children:React.ReactNode}) {
  return (
    <div className={span===2?"md:col-span-2":span===3?"md:col-span-3":""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
        {label}{req&&<span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint&&<p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CALCULADOR EN VIVO
// ══════════════════════════════════════════════════════════════════════════════

function SugerenciaEnVivo({
  origen, destino, tipoVeh, tipoServ, equip, km, dias, peajes, pernocte, viaticos,
  modoServ, tarifas, onAplicar,
}:{
  origen:string; destino:string; tipoVeh:string; tipoServ:string; equip:string;
  km:number; dias:number; peajes:number; pernocte:number; viaticos:number;
  modoServ:ModoServ; tarifas:Tarifa[];
  onAplicar:(sinIGV:number, fuente:string, costo?:number)=>void;
}) {
  const costo = useMemo(
    () => calcCosto(tipoVeh, km>0?km:1, dias, peajes, pernocte, viaticos),
    [tipoVeh, km, dias, peajes, pernocte, viaticos]
  );

  const tarifaExacta = useMemo(() => tarifas.find(t =>
    norm(t.origen)===norm(origen) && norm(t.destino)===norm(destino) &&
    t.tipo_vehiculo===tipoVeh && t.equipamiento===equip &&
    t.tipo_servicio===tipoServ && (t.modo||"eventual")===modoServ
  ), [tarifas, origen, destino, tipoVeh, equip, tipoServ, modoServ]);

  const vehInfo = TIPOS_VEH.find(v => v.id===tipoVeh);
  if (!FLOTA_COSTOS[tipoVeh] && !tarifaExacta) return null;

  const tarifConIGV = tarifaExacta ? tarifaExacta.precio*(modoServ==="eventual"?1.18:1.18) : null;
  const esFijo = modoServ === "fijo";

  // Precios según modo
  const cPrecioMin = esFijo ? costo?.diaMin*(1+IGV) : costo?.totalMin15;
  const cPrecioEst = esFijo ? costo?.diaEstIGV       : costo?.totalEst20;
  const cPrecioAlt = esFijo ? costo?.diaEst*(1+IGV)*(1.25/1.20) : costo?.totalAlto25;
  const cSinIGVEst = esFijo ? costo?.diaEst          : costo?.sinIGV20;
  const precioSug  = Math.max(cPrecioEst||0, tarifConIGV||0);

  return (
    <div className="rounded-2xl overflow-hidden border-2 border-[#0b315f]" style={{background:"#0b315f"}}>
      {/* Header */}
      <div className="px-5 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-white/15 flex items-center justify-center">⚡</div>
          <div>
            <p className="font-black text-white text-sm">Calculador en tiempo real</p>
            <p className="text-white/50 text-[10px]">
              {vehInfo?.icon} {vehInfo?.label} · {km||"?"} km
              {esFijo ? " (km diarios)" : ` · ${dias} día(s)`}
              {esFijo ? " · FIJO/día" : " · EVENTUAL/viaje"}
            </p>
          </div>
        </div>
        <div className={`px-3 py-1 rounded-xl text-[11px] font-bold ${enHorario()?"bg-green-500/20 text-green-300":"bg-amber-500/20 text-amber-300"}`}>
          {enHorario()?"🟢 Horario oficina":"🟡 Fuera horario"}
        </div>
      </div>

      <div className="px-5 pb-5 space-y-3">
        {/* Tres columnas */}
        <div className="grid grid-cols-3 gap-2">
          {/* Mínimo */}
          <div className="rounded-xl bg-red-500/10 border border-red-400/20 p-3">
            <p className="text-[9px] font-black text-red-300 uppercase mb-1">⛔ Mínimo 15%</p>
            {km>0&&costo ? (
              <>
                <p className="font-black text-lg text-white font-mono">{fmtS(cPrecioMin||0)}</p>
                <p className="text-[9px] text-red-300/70 mt-0.5">{esFijo?"/día (con IGV)":"con IGV"}</p>
                <button onClick={()=>onAplicar((cPrecioMin||0)/1.18,"cotizador_min",costo.baseCosto)}
                  className="mt-2 w-full py-1 rounded-lg text-[10px] font-black text-white bg-red-500/30 hover:bg-red-500/50 transition-colors">
                  Usar mínimo
                </button>
              </>
            ) : <p className="text-white/25 text-xs mt-1">Ingresa km</p>}
          </div>

          {/* Estándar */}
          <div className="rounded-xl bg-blue-500/15 border-2 border-blue-400/40 p-3 relative">
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[8px] font-black px-2 py-0.5 rounded-full whitespace-nowrap">RECOMENDADO</div>
            <p className="text-[9px] font-black text-blue-300 uppercase mb-1">🔧 Estándar 20%</p>
            {km>0&&costo ? (
              <>
                <p className="font-black text-lg text-white font-mono">{fmtS(cPrecioEst||0)}</p>
                <p className="text-[9px] text-blue-300/70 mt-0.5">
                  {esFijo ? `~${fmtS(costo.mesEstIGV)}/mes` : `S/${(costo.precioPax20||0).toFixed(0)}/pax`}
                </p>
                <button onClick={()=>onAplicar(cSinIGVEst||0,"cotizador",costo.baseCosto)}
                  className="mt-2 w-full py-1 rounded-lg text-[10px] font-black text-white bg-blue-500 hover:bg-blue-400 transition-colors">
                  ✓ Usar estándar
                </button>
              </>
            ) : <p className="text-white/25 text-xs mt-1">Ingresa km</p>}
          </div>

          {/* Tarifario / Alto */}
          <div className={`rounded-xl p-3 border ${tarifaExacta?"bg-green-500/15 border-green-400/40":"bg-white/8 border-white/15"}`}>
            {tarifaExacta ? (
              <>
                <p className="text-[9px] font-black text-green-300 uppercase mb-1">📋 Tarifario</p>
                <p className="font-black text-lg text-white font-mono">{fmtS(tarifConIGV||0)}</p>
                <p className="text-[9px] text-green-300/70 mt-0.5">
                  {tarifaExacta.notas||`${origen}→${destino}`}
                </p>
                <button onClick={()=>onAplicar(tarifaExacta.precio,"tarifario")}
                  className="mt-2 w-full py-1 rounded-lg text-[10px] font-black text-white bg-green-600 hover:bg-green-500 transition-colors">
                  ✓ Usar tarifario
                </button>
              </>
            ) : (
              <>
                <p className="text-[9px] font-black text-white/40 uppercase mb-1">📋 Tarifario</p>
                <p className="text-white/25 text-xs mt-1">
                  {origen&&destino?`Sin tarifa: ${origen}→${destino}`:"Ingresa origen y destino"}
                </p>
                {km>0&&costo&&(
                  <button onClick={()=>onAplicar((cPrecioAlt||0)/1.18,"cotizador_alto",costo.baseCosto)}
                    className="mt-2 w-full py-1 rounded-lg text-[10px] font-black text-white bg-white/10 hover:bg-white/20 transition-colors border border-white/15">
                    25%: {fmtS(cPrecioAlt||0)}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Precio sugerido */}
        {precioSug>0 && (
          <div className="rounded-xl bg-white/10 border border-white/20 px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-white/50 text-[10px] font-bold uppercase">
                ⭐ Precio sugerido — {enHorario()?"tú decides":"automático fuera de horario"}
              </p>
              <p className="text-white font-black text-xl font-mono mt-0.5">{fmtS(precioSug)}</p>
              {esFijo && costo && <p className="text-white/40 text-[10px]">~{fmtS(precioSug*26)}/mes</p>}
            </div>
            <button onClick={()=>onAplicar(precioSug/1.18,"sugerido",costo?.baseCosto)}
              className="px-4 py-2.5 rounded-xl font-black text-sm bg-white text-[#0b315f] hover:bg-gray-100 transition-all flex-shrink-0">
              → Aplicar
            </button>
          </div>
        )}

        {/* Desglose colapsable */}
        {costo&&km>0&&(
          <details className="group">
            <summary className="cursor-pointer text-white/40 text-[10px] font-bold hover:text-white/60 list-none flex items-center gap-1.5">
              <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
              Ver desglose de costos
            </summary>
            <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-1.5">
              {[
                {label:"Combustible", val:costo.baseCosto*0.25, color:"#fbbf24"},
                {label:"Neumáticos",  val:costo.baseCosto*0.05, color:"#a78bfa"},
                {label:"Mantenimiento",val:costo.baseCosto*0.08,color:"#34d399"},
                {label:"Depreciación",val:costo.baseCosto*0.10, color:"#60a5fa"},
                {label:"Seguros",     val:costo.baseCosto*0.07, color:"#f87171"},
                {label:"Conductor",   val:costo.baseCosto*0.20, color:"#fb923c"},
                {label:"Overhead",    val:costo.baseCosto*0.10, color:"#e879f9"},
                {label:"Base total",  val:costo.baseCosto,      color:"#ffffff"},
              ].map(i=>(
                <div key={i.label} className="bg-white/8 rounded-lg px-2 py-1.5">
                  <p className="text-[8px] uppercase text-white/30 font-bold">{i.label}</p>
                  <p className="text-xs font-black mt-0.5" style={{color:i.color}}>{fmtS(i.val)}</p>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PANEL DECISIÓN DE PRECIOS (en tabla)
// ══════════════════════════════════════════════════════════════════════════════

function PanelDecision({c,onAct}:{c:Cotizacion;onAct:()=>void}) {
  const [guardando,setGuardando]=useState(false);
  const [descPct,  setDescPct]  =useState(c.descuento_pct_solicitado?.toString()||"");
  const enOf = enHorario();
  if(!c.precio_cotizador&&!c.precio_tarifario) return null;

  const esFijo = c.modo_servicio==="fijo";
  const tarifIGV = c.precio_tarifario?c.precio_tarifario*1.18:null;
  const precSug  = Math.max(c.precio_cotizador||0,tarifIGV||0)||Number(c.precio_cliente);
  const precDesc = c.descuento_pct_solicitado?precSug*(1-c.descuento_pct_solicitado/100):null;
  const fuente   = c.precio_cotizador&&tarifIGV?(c.precio_cotizador>=tarifIGV?"Cotizador":"Tarifario"):c.precio_cotizador?"Cotizador":"Tarifario";

  async function getCosto(){const{data}=await supabase.from("cotizaciones").select("costo_estimado").eq("id",c.id).single();return Number(data?.costo_estimado||0);}
  async function aplicar(precio:number,modo:string){setGuardando(true);const costo=await getCosto();await supabase.from("cotizaciones").update({precio_cliente:precio,margen_estimado:precio-costo,precio_sugerido:precSug,modo_precio:modo,enviado_automatico:!enOf}).eq("id",c.id);setGuardando(false);onAct();}
  async function solDesc(){const pct=parseFloat(descPct);if(!pct||pct<=0||pct>=100)return;setGuardando(true);await supabase.from("cotizaciones").update({descuento_solicitado:true,descuento_pct_solicitado:pct,descuento_autorizado:false,hora_solicitud_descuento:new Date().toISOString()}).eq("id",c.id);setGuardando(false);onAct();}
  async function autDesc(){if(!precDesc)return;setGuardando(true);const costo=await getCosto();await supabase.from("cotizaciones").update({precio_cliente:precDesc,margen_estimado:precDesc-costo,descuento_autorizado:true,modo_precio:"descuento_autorizado"}).eq("id",c.id);setGuardando(false);onAct();}
  async function rechDesc(){setGuardando(true);await supabase.from("cotizaciones").update({descuento_autorizado:false,descuento_solicitado:false}).eq("id",c.id);setGuardando(false);onAct();}

  return (
    <div className="mt-2 rounded-xl border overflow-hidden" style={{borderColor:"#0b315f22"}}>
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap" style={{background:"#eef3f8"}}>
        <span className="text-[11px] font-black text-[#0b315f]">💡 Decisión de precio{esFijo?" · FIJO":""}</span>
        {c.precio_cotizador&&<span className="text-[10px] bg-blue-100 text-blue-700 font-bold px-1.5 py-0.5 rounded-full">🔧 {fmtS(c.precio_cotizador)}{esFijo?"/día":""}</span>}
        {tarifIGV&&<span className="text-[10px] bg-green-100 text-green-700 font-bold px-1.5 py-0.5 rounded-full">📋 {fmtS(tarifIGV)}{esFijo?"/día":""}</span>}
        <span className="text-[10px] bg-[#0b315f] text-white font-bold px-1.5 py-0.5 rounded-full">⭐ {fmtS(precSug)} ({fuente})</span>
        {c.descuento_solicitado&&!c.descuento_autorizado&&<span className="text-[10px] bg-orange-100 text-orange-700 font-bold px-1.5 py-0.5 rounded-full animate-pulse">🙋 {c.descuento_pct_solicitado}% pendiente</span>}
        {esFijo&&c.precio_mes_estimado&&<span className="text-[10px] bg-green-50 text-green-700 font-bold px-1.5 py-0.5 rounded-full">📅 ~{fmtS(c.precio_mes_estimado)}/mes</span>}
      </div>
      <div className="p-3 bg-white space-y-3">
        {!enOf&&<div className="rounded-xl px-3 py-2 flex items-center gap-2 border border-amber-200 bg-amber-50 text-xs text-amber-800 font-semibold"><span>⏰</span>Fuera de horario L-V 8-18h — precio máximo sugerido automáticamente</div>}
        {c.descuento_solicitado&&!c.descuento_autorizado&&(
          <div className="rounded-xl border-2 border-orange-300 bg-orange-50 p-3">
            <p className="font-black text-orange-800 text-sm mb-2">🙋 Descuento {c.descuento_pct_solicitado}% → {precDesc?fmtS(precDesc):"—"}</p>
            {enOf?<div className="flex gap-2"><button onClick={autDesc} disabled={guardando} className="flex-1 py-1.5 rounded-xl font-black text-xs text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">✅ Autorizar {precDesc?fmtS(precDesc):""}</button><button onClick={rechDesc} disabled={guardando} className="px-3 py-1.5 rounded-xl font-bold text-xs border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">✕</button></div>:<p className="text-orange-600 text-xs font-bold text-center bg-orange-100 rounded-lg py-1.5">⏰ Se responderá en horario de oficina</p>}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          {[
            {label:"🔧 Cotizador", val:c.precio_cotizador, color:"blue", modo:"cotizador"},
            {label:"📋 Tarifario", val:tarifIGV, color:"green", modo:"tarifario"},
            {label:"⭐ Sugerido",  val:precSug,  color:"navy", modo:"sugerido"},
          ].map(item=>(
            <div key={item.label} className={`rounded-xl border-2 p-2.5 ${item.color==="blue"?"border-blue-200 bg-blue-50":item.color==="green"?"border-green-200 bg-green-50":"border-[#0b315f] bg-[#eef3f8]"}`}>
              <p className={`text-[9px] font-bold uppercase mb-1 ${item.color==="blue"?"text-blue-600":item.color==="green"?"text-green-600":"text-[#0b315f]"}`}>{item.label}</p>
              <p className={`font-black text-sm font-mono ${item.color==="blue"?"text-blue-700":item.color==="green"?"text-green-700":"text-[#0b315f]"}`}>{item.val?fmtS(item.val):"—"}</p>
              {esFijo&&item.val&&<p className="text-[9px] text-gray-400">~{fmtS(item.val*26)}/mes</p>}
              {item.val&&enOf&&<button onClick={()=>aplicar(item.val!,item.modo)} disabled={guardando||Math.abs(Number(c.precio_cliente)-item.val)<0.01} className={`mt-1.5 w-full py-1 rounded-lg text-[10px] font-black text-white disabled:opacity-40 transition-colors ${item.color==="blue"?"bg-blue-600 hover:bg-blue-700":item.color==="green"?"bg-green-600 hover:bg-green-700":"bg-[#0b315f] hover:bg-[#1262bd]"}`}>{Math.abs(Number(c.precio_cliente)-item.val)<0.01?"✓ Aplicado":"Usar"}</button>}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2">
          <div><p className="text-[10px] text-gray-400 font-bold uppercase">Precio actual</p><p className="font-black text-sm text-gray-800">{fmtS(Number(c.precio_cliente))}{esFijo?<span className="text-[10px] text-gray-400 font-normal ml-1">/día</span>:null}</p></div>
          <div className="text-right"><p className="text-[10px] text-gray-400">Modo: <span className="font-bold text-gray-600">{c.modo_precio||"manual"}</span></p>{c.enviado_automatico&&<span className="text-[9px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full block">🤖 Auto</span>}</div>
        </div>
        {!c.descuento_solicitado&&!c.descuento_autorizado&&(
          <div className="border border-dashed border-gray-200 rounded-xl p-2.5">
            <p className="text-[9px] font-bold text-gray-400 uppercase mb-1.5">🙋 Registrar descuento del cliente</p>
            <div className="flex gap-2">
              <input type="number" min={1} max={50} placeholder="%" value={descPct} onChange={e=>setDescPct(e.target.value)} className="flex-1 border border-gray-200 rounded-xl px-2.5 py-1.5 text-sm outline-none focus:border-[#0b315f]"/>
              <button onClick={solDesc} disabled={guardando||!descPct} className="px-3 py-1.5 rounded-xl font-bold text-xs text-white bg-orange-500 hover:bg-orange-600 disabled:opacity-40">Registrar</button>
            </div>
            {descPct&&parseFloat(descPct)>0&&<p className="text-[9px] text-gray-400 mt-1">Con {descPct}% → <span className="font-bold text-gray-600">{fmtS(precSug*(1-parseFloat(descPct)/100))}</span>{!enOf&&<span className="text-amber-600 font-bold ml-1">· Horario oficina</span>}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL APROBACIÓN
// ══════════════════════════════════════════════════════════════════════════════

function ModalAprobacion({cot,onConfirmar,onCancelar}:{cot:Cotizacion;onConfirmar:(tipo:string,numero:string)=>void;onCancelar:()=>void}) {
  const [tipo,  setTipo]  = useState("Operación bancaria");
  const [num,   setNum]   = useState("");
  const [err,   setErr]   = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{background:"rgba(0,0,0,0.5)"}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center text-xl">✅</div>
          <div><h3 className="text-base font-bold">Aprobar cotización</h3><p className="text-xs text-gray-400">#{cot.numero_cotizacion||cot.id} · {fmtS(Number(cot.precio_cliente))}</p></div>
        </div>
        <div><label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">Tipo de documento *</label><select className={iCls()} value={tipo} onChange={e=>setTipo(e.target.value)}>{TIPOS_APROBACION.map(t=><option key={t}>{t}</option>)}</select></div>
        <div><label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">N° referencia *</label><input className={iCls("font-mono")} placeholder="Número o código" value={num} onChange={e=>{setNum(e.target.value);setErr("");}} autoFocus onKeyDown={e=>e.key==="Enter"&&(num.trim()?onConfirmar(tipo,num.trim()):setErr("Obligatorio"))}/>{err&&<p className="text-xs text-red-600 mt-1">⚠ {err}</p>}</div>
        <div className="flex gap-3"><button onClick={()=>num.trim()?onConfirmar(tipo,num.trim()):setErr("Obligatorio")} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-green-700">✅ Confirmar</button><button onClick={onCancelar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600">Cancelar</button></div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PARADAS BUILDER (simplificado)
// ══════════════════════════════════════════════════════════════════════════════

function ParadasBuilder({paradas,onChange,tipo="solo_ida"}:{paradas:ParadaTP[];onChange:(p:ParadaTP[])=>void;tipo?:string}) {
  const nId=()=>Math.random().toString(36).slice(2,8);
  const inicio=paradas.find(p=>p.tipo==="inicio");
  const fin=paradas.find(p=>p.tipo==="destino");
  const meds=paradas.filter(p=>p.tipo==="intermedia");
  const upd=(id:string,k:keyof ParadaTP,v:string)=>onChange(paradas.map(p=>p.id===id?{...p,[k]:v}:p));
  const addMed=()=>{const n:ParadaTP={id:nId(),tipo:"intermedia",nombre:"",direccion:"",lat:"",lng:"",hora:""};const idx=paradas.findIndex(p=>p.tipo==="destino");const a=[...paradas];a.splice(idx<0?a.length:idx,0,n);onChange(a);};
  const delMed=(id:string)=>onChange(paradas.filter(p=>p.id!==id));
  const inp="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]";
  const esTP=tipo==="transporte_personal"||tipo==="fijo_multiparada";

  if(paradas.length===0) return (
    <div className="rounded-2xl border-2 border-dashed p-8 text-center" style={{borderColor:"#be185d"}}>
      <p className="text-3xl mb-2">🚏</p>
      <p className="font-bold text-gray-700 mb-3">{esTP?"Define los paraderos del recorrido":"Define los puntos del servicio"}</p>
      <button onClick={()=>onChange([{id:nId(),tipo:"inicio",nombre:"",direccion:"",lat:"",lng:"",hora:""},{id:nId(),tipo:"destino",nombre:"",direccion:"",lat:"",lng:"",hora:""}])}
        className="px-6 py-2.5 rounded-xl font-bold text-sm text-white" style={{background:"#0b315f"}}>
        🗺️ Definir puntos
      </button>
    </div>
  );

  function Card({p,lbl,col}:{p:ParadaTP;lbl:string;col:string}) {
    return (
      <div className="bg-white rounded-2xl border-2 overflow-hidden" style={{borderColor:col}}>
        <div className="px-4 py-2.5" style={{background:col}}><span className="text-white font-black text-sm">{lbl}</span></div>
        <div className="p-4 space-y-2.5">
          <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Nombre *</label><input className={inp} value={p.nombre} onChange={e=>upd(p.id,"nombre",e.target.value)}/></div>
          <div className="grid grid-cols-3 gap-2">
            <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Latitud</label><input className={inp+" font-mono"} placeholder="-12.04" value={p.lat} onChange={e=>upd(p.id,"lat",e.target.value)}/></div>
            <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Longitud</label><input className={inp+" font-mono"} placeholder="-77.04" value={p.lng} onChange={e=>upd(p.id,"lng",e.target.value)}/></div>
            <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Hora</label><input type="time" className={inp} value={p.hora} onChange={e=>upd(p.id,"hora",e.target.value)}/></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {inicio&&<Card p={inicio} lbl={esTP?"🟢 Primer Paradero":"🟢 Punto Inicio"} col="#16a34a"/>}
      {meds.map((p,i)=>(
        <div key={p.id} className="bg-white rounded-2xl border-2 overflow-hidden" style={{borderColor:"#0b315f"}}>
          <div className="px-4 py-2.5 flex items-center justify-between" style={{background:"#0b315f"}}>
            <span className="text-white font-black text-sm">📍 {esTP?"Paradero":"Parada"} {i+1}</span>
            <button onClick={()=>delMed(p.id)} className="text-white opacity-60 hover:opacity-100 font-bold">✕</button>
          </div>
          <div className="p-4 space-y-2.5">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Nombre *</label><input className={inp} value={p.nombre} onChange={e=>upd(p.id,"nombre",e.target.value)}/></div>
              <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Hora</label><input type="time" className={inp} value={p.hora} onChange={e=>upd(p.id,"hora",e.target.value)}/></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Lat</label><input className={inp+" font-mono text-xs"} value={p.lat} onChange={e=>upd(p.id,"lat",e.target.value)}/></div>
              <div><label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Lng</label><input className={inp+" font-mono text-xs"} value={p.lng} onChange={e=>upd(p.id,"lng",e.target.value)}/></div>
            </div>
          </div>
        </div>
      ))}
      <button onClick={addMed} className="w-full py-2.5 rounded-xl border-2 border-dashed font-bold text-sm hover:bg-blue-50 transition-colors" style={{borderColor:"#0b315f",color:"#0b315f"}}>
        + Agregar {esTP?"paradero":"parada intermedia"}
      </button>
      {fin&&<Card p={fin} lbl={esTP?"🔴 Último Paradero":"🔴 Punto Destino"} col="#dc2626"/>}
      {paradas.length>0&&(
        <div className="rounded-xl border px-3 py-2.5" style={{background:"#fce7f3",borderColor:"#f9a8d4"}}>
          <p className="text-[#be185d] font-black text-xs uppercase mb-1.5">Resumen del recorrido</p>
          <div className="space-y-0.5">
            {[...paradas.filter(p=>p.tipo==="inicio"),...paradas.filter(p=>p.tipo==="intermedia"),...paradas.filter(p=>p.tipo==="destino")].map((p,i)=>(
              <div key={p.id} className="flex items-center gap-2 text-xs">
                <span className="font-black text-[#be185d] w-4">{i+1}.</span>
                <span className="font-bold text-gray-700">{p.nombre||"Sin nombre"}</span>
                {p.hora&&<span className="text-gray-400">· {p.hora}</span>}
                {p.lat&&p.lng&&<span className="text-green-600">📍</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

function generarPDF(cot:Cotizacion,cliente:Cliente|undefined,items:ItemCot[],vehiculo:VehiculoFlota|undefined,repr="JENNY ELYZABETH URBINA AFATA",consid:ConsidCot=DEFAULT_CONSID) {
  const {subtotal,igv,total}=calcItems(items);
  const desc=items.reduce((s,it)=>s+it.dias*it.cantidad*it.precio_unit*(it.descuento_pct/100),0);
  const nomCl=cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—";
  const rucDni=cliente?.ruc?`RUC: ${cliente.ruc}`:cliente?.dni?`DNI: ${cliente.dni}`:"—";
  const aten=cot.atencion||cliente?.operativo_nombre||cliente?.administrativo_nombre||"—";
  const nCot=cot.numero_cotizacion||String(cot.id).padStart(5,"0");
  const fechaDoc=cot.created_at?new Date(cot.created_at).toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}):new Date().toLocaleDateString("es-PE");
  const anio=new Date().getFullYear();
  const esFull=(vehiculo?.equipamiento||cot.equipamiento||"full_equipo")==="full_equipo";
  const descUnidad=vehiculo?.descripcion_unidad||(esFull?`Bus con capacidad para ${vehiculo?.capacidad_pasajeros||"—"} pasajeros, con aire acondicionado, sistema de audio, asientos reclinables, bodega y GPS.`:`Bus con capacidad para ${vehiculo?.capacidad_pasajeros||"—"} pasajeros, estándar, bodega y GPS.`);
  const filasItems=items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return`<tr><td style="text-align:center;padding:6px;border:1px solid #ccc;">${i+1}</td><td style="padding:6px;border:1px solid #ccc;">${it.descripcion}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.dias}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.cantidad}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;">S/ ${it.precio_unit.toLocaleString("es-PE",{minimumFractionDigits:2})}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.descuento_pct>0?it.descuento_pct+"%":""}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;font-weight:bold;">S/ ${tf.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;}).join("");
  const fotosHtml=vehiculo&&(vehiculo.foto_externa_url||vehiculo.foto_interna_url)?`<div style="margin-top:12px;display:grid;grid-template-columns:${vehiculo.foto_externa_url&&vehiculo.foto_interna_url?"1fr 1fr":"1fr"};gap:10px;">${vehiculo.foto_externa_url?`<div><p style="font-size:9px;font-weight:700;color:#6b7280;margin-bottom:4px;">Vista exterior</p><div style="background:#f3f4f6;border-radius:8px;border:1px solid #e5e7eb;height:180px;display:flex;align-items:center;justify-content:center;overflow:hidden;"><img src="${driveImg(vehiculo.foto_externa_url)}" style="max-width:100%;max-height:180px;object-fit:contain;"/></div><p style="font-size:8px;color:#9ca3af;text-align:center;margin-top:3px;font-style:italic;">IMAGEN REFERENCIAL</p></div>`:""}${vehiculo.foto_interna_url?`<div><p style="font-size:9px;font-weight:700;color:#6b7280;margin-bottom:4px;">Vista interior</p><div style="background:#f3f4f6;border-radius:8px;border:1px solid #e5e7eb;height:180px;display:flex;align-items:center;justify-content:center;overflow:hidden;"><img src="${driveImg(vehiculo.foto_interna_url)}" style="max-width:100%;max-height:180px;object-fit:contain;"/></div><p style="font-size:8px;color:#9ca3af;text-align:center;margin-top:3px;font-style:italic;">IMAGEN REFERENCIAL</p></div>`:""}</div>`:"";

  // Nota especial para servicios FIJO
  const notaFijo=cot.modo_servicio==="fijo"?`<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:8px 12px;margin-top:8px;font-size:10.5px;"><b style="color:#166534;">📅 Servicio de Transporte Fijo</b> — Precio por día: <b>${fmtS(Number(cot.precio_dia||0))}</b> · Estimado mensual (×26 días): <b>${fmtS(Number(cot.precio_mes_estimado||0))}</b></div>`:"";

  const win=window.open("","_blank");
  if(!win)return;
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Cotización N° ${nCot} - AFA TOURS PERU</title><style>@page{size:A4;margin:18mm 15mm}*{box-sizing:border-box}body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0;line-height:1.4}.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;border-bottom:3px solid #0b315f;padding-bottom:10px}.logo{height:60px}.titulo{text-align:right}.titulo h1{font-size:18px;font-weight:900;color:#0b315f;margin:0}.titulo p{margin:2px 0;font-size:11px;color:#444}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.box{border:1px solid #ccc;border-radius:4px;padding:8px 10px}.box-title{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:6px}.box-row{margin:3px 0;font-size:10.5px}table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10.5px}thead{background:#0b315f;color:white}thead th{padding:6px;text-align:center;font-weight:700;font-size:10px;border:1px solid #0b315f}tbody tr:nth-child(even){background:#f8fafc}.totales td{padding:4px 10px;font-size:11px}.totales .label{text-align:right;color:#555;font-weight:600}.totales .valor{text-align:right;font-weight:700}.totales .total-neto{font-size:13px;font-weight:900;color:#0b315f}.totales .sep{border-top:2px solid #0b315f}.cuentas{margin-top:12px;border-top:2px solid #0b315f;padding-top:10px}.cuentas h3{font-size:11px;font-weight:900;color:#0b315f;margin:0 0 6px}.cuentas-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.cuenta-box{border:1px solid #ddd;border-radius:4px;padding:6px 8px}.cuenta-box .banco{font-weight:900;font-size:10px;color:#0b315f;margin-bottom:3px}.cuenta-box p{margin:1px 0;font-size:9.5px}.page-break{page-break-before:always}.anexo h3{font-size:10.5px;font-weight:900;margin:8px 0 4px;text-transform:uppercase}.anexo li{font-size:10.5px;color:#333;line-height:1.6}.footer-doc{margin-top:14px;border-top:2px solid #0b315f;padding-top:6px;text-align:center;font-size:9px;color:#0b315f}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
<div class="header"><img src="/logoafacotizacion.jpg" alt="AFA TOURS PERU" class="logo"/><div class="titulo"><h1>COTIZACIÓN N° ${nCot} - ${anio}</h1><p><b>FECHA:</b> ${fechaDoc}</p><p style="font-style:italic;color:#666;font-size:10px;">Válida por 30 días</p></div></div>
<div class="grid2"><div class="box"><div class="box-title">Datos del cliente</div><div class="box-row"><b>CLIENTE:</b> ${nomCl}</div><div class="box-row"><b>${cliente?.ruc?"RUC":"DNI"}:</b> ${rucDni.replace(/^(RUC|DNI): /,"")}</div><div class="box-row"><b>DIRECCIÓN:</b> ${cliente?.direccion||"—"}</div><div class="box-row"><b>CELULAR:</b> ${cliente?.telefono||"—"}</div><div class="box-row"><b>ATENCIÓN:</b> ${aten}</div></div><div class="box"><div class="box-title">AFA Tours Peru S.A.C.</div><div class="box-row"><b>RUC:</b> 20602117091</div><div class="box-row"><b>DIRECCIÓN:</b> MZA. F LOTE. 2 ASC. TRABAJADORES UNIDOS CHACRASANA - LURIGANCHO</div><div class="box-row"><b>REPR:</b> ${repr}</div><div class="box-row"><b>EMAIL:</b> transporte@afatoursperu.com</div><div class="box-row"><b>TELF:</b> (01) 3453707 – 966 707 225</div></div></div>
<div class="box" style="margin-bottom:10px;"><div class="box-title">Detalle del servicio</div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;"><div class="box-row"><b>ORIGEN:</b> ${cot.origen||"—"}</div><div class="box-row"><b>DESTINO:</b> ${cot.destino||"—"}</div><div class="box-row"><b>RETORNO:</b> ${cot.punto_retorno||cot.origen||"—"}</div></div>${cot.asunto?`<div class="box-row" style="margin-top:4px;"><b>ASUNTO:</b> ${cot.asunto}</div>`:""}<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"><div class="box-row"><b>FECHA:</b> ${cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase():"_____________"}</div><div class="box-row"><b>HORARIO:</b> Salida: <b>${cot.hora_ida||"_____"}</b> | Retorno: <b>${cot.hora_retorno||"_____"}</b></div></div>${notaFijo}</div>
<table><thead><tr><th style="width:40px;">ITEM</th><th style="text-align:left;">DESCRIPCIÓN</th><th style="width:45px;">DÍAS</th><th style="width:55px;">CANT.</th><th style="width:110px;">P. UNIT S/ sin IGV</th><th style="width:55px;">% DSCTO.</th><th style="width:110px;">TOTAL S/</th></tr></thead><tbody>${filasItems}<tr><td colspan="4" style="border:1px solid #ccc;padding:6px 8px;font-size:9.5px;color:#555;font-style:italic;"><b>INCLUYE:</b> Traslado, conductor, combustible y peajes de ruta.</td><td colspan="3" style="border:1px solid #ccc;padding:0;vertical-align:top;"><table class="totales"><tr><td class="label">SUBTOTAL</td><td class="valor">S/ ${subtotal.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>${desc>0?`<tr><td class="label">DESCUENTO</td><td class="valor" style="color:#dc2626;">- S/ ${desc.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`:""}<tr><td class="label">IGV (18%)</td><td class="valor">S/ ${igv.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr><tr class="sep"><td class="label total-neto">TOTAL NETO</td><td class="valor total-neto">S/ ${total.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr></table></td></tr></tbody></table>
<div style="margin-top:16px;display:flex;justify-content:flex-end;"><div style="text-align:center;border-top:1px solid #333;padding-top:5px;width:180px;font-size:10px;color:#555;">REVISADO POR</div></div>
<div class="cuentas"><h3>Nuestras cuentas bancarias</h3><div class="cuentas-grid"><div class="cuenta-box"><div class="banco">BCP — Cuenta Soles</div><p>Cta. Corriente: 191-2644342-0-24</p><p>CCI: 00219100264434202450</p></div><div class="cuenta-box"><div class="banco">BCP — Cuenta Dólares</div><p>Cta.: 191-7394169-1-83</p><p>CCI: 00219100739416918351</p></div><div class="cuenta-box"><div class="banco">Banco de la Nación (Detracción)</div><p>Cta.: 00-091-069571</p><p>CCI: 01809100009106957197</p></div></div></div>
<div class="footer-doc">📍 Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana - Lima &nbsp;|&nbsp; 📞 (01) 3453707 &nbsp;·&nbsp; 📱 966 707 225 &nbsp;|&nbsp; ✉️ transporte@afatoursperu.com</div>
<div class="page-break"></div>
<div class="header"><img src="/logoafacotizacion.jpg" class="logo"/><div class="titulo"><h1>COTIZACIÓN N° ${nCot} - ${anio}</h1><p style="font-size:12px;font-weight:700;color:#6b7280;">Descripción de la unidad y condiciones</p></div></div>
<div class="box" style="margin-bottom:10px;"><div class="box-title">Características de la unidad</div><div class="box-row" style="line-height:1.6;">${descUnidad}</div></div>
${fotosHtml}
<div class="anexo"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;"><div><h3 style="color:#166534;border-bottom:2px solid #16a34a;padding-bottom:3px;">✅ Servicio incluye</h3><ul>${consid.incluye.map(i=>`<li>${i}</li>`).join("")}</ul></div><div><h3 style="color:#991b1b;border-bottom:2px solid #dc2626;padding-bottom:3px;">❌ No incluye</h3><ul>${consid.no_incluye.map(i=>`<li>${i}</li>`).join("")}</ul></div></div><h3 style="color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:3px;">📋 Consideraciones generales</h3><ul>${consid.generales.map(i=>`<li>${i}</li>`).join("")}</ul></div>
<div class="footer-doc" style="margin-top:24px;">📍 Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana - Lima &nbsp;|&nbsp; 📞 (01) 3453707 &nbsp;·&nbsp; 📱 966 707 225 &nbsp;|&nbsp; ✉️ transporte@afatoursperu.com</div>
<script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

// ══════════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

export default function CotizacionesPage() {
  const [clientes,   setClientes]   = useState<Cliente[]>([]);
  const [cotizas,    setCotizas]    = useState<Cotizacion[]>([]);
  const [tarifas,    setTarifas]    = useState<Tarifa[]>([]);
  const [flota,      setFlota]      = useState<VehiculoFlota[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [guardando,  setGuardando]  = useState(false);
  const [mostrarForm,setMostrarForm]= useState(false);
  const [editandoId, setEditandoId] = useState<number|null>(null);
  const [busqueda,   setBusqueda]   = useState("");
  const [filtroEst,  setFiltroEst]  = useState("todos");
  const [filtroModo, setFiltroModo] = useState("todos");
  const [form,       setForm]       = useState(FORM0);
  const [items,      setItems]      = useState<ItemCot[]>([{...ITEM_VACIO}]);
  const [modalAprob, setModalAprob] = useState<Cotizacion|null>(null);
  const [guardarTar, setGuardarTar] = useState(true);
  const [paradas,    setParadas]    = useState<ParadaTP[]>([]);
  const [consid,     setConsid]     = useState<ConsidCot>(DEFAULT_CONSID);
  const [panelId,    setPanelId]    = useState<number|null>(null);
  const [diasCond,   setDiasCond]   = useState(1);
  const [peajesF,    setPeajesF]    = useState(0);
  const [pernocteF,  setPernocteF]  = useState(0);
  const [viaticosF,  setViaticosF]  = useState(0);
  const [reprNombre, setReprNombre] = useState("JENNY ELYZABETH URBINA AFATA");

  const f = (k:keyof typeof FORM0) => (e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>) =>
    setForm(p=>({...p,[k]:e.target.value}));

  useEffect(()=>{
    supabase.auth.getUser().then(({data})=>{
      if(data?.user){const m=data.user.user_metadata;setReprNombre((m?.full_name||m?.name||data.user.email||"JENNY ELYZABETH URBINA AFATA").toUpperCase());}
    });
  },[]);

  const cargar=async()=>{
    setLoading(true);
    const [clR,cotR,tR,vR]=await Promise.all([
      supabase.from("clientes").select("*").order("nombre").limit(1000),
      supabase.from("cotizaciones").select("*").order("id",{ascending:false}),
      supabase.from("tarifario").select("*").eq("activo",true),
      supabase.from("vehiculos").select("id,placa,categoria,marca,modelo,anio,capacidad_pasajeros,equipamiento,foto_externa_url,foto_interna_url,descripcion_unidad").order("placa"),
    ]);
    setClientes(clR.data||[]);setCotizas(cotR.data||[]);setTarifas(tR.data||[]);setFlota(vR.data||[]);
    setLoading(false);
  };
  useEffect(()=>{cargar();},[]);

  const updItem=(i:number,k:keyof ItemCot,v:string|number)=>setItems(p=>p.map((it,idx)=>idx===i?{...it,[k]:Number.isNaN(Number(v))?v:Number(v)}:it));
  const addItem=()=>setItems(p=>[...p,{...ITEM_VACIO}]);
  const delItem=(i:number)=>setItems(p=>p.filter((_,idx)=>idx!==i));
  const {subtotal,igv,total}=calcItems(items);

  const limpiar=()=>{setForm(FORM0);setItems([{...ITEM_VACIO}]);setConsid(DEFAULT_CONSID);setParadas([]);setEditandoId(null);setMostrarForm(false);setDiasCond(1);setPeajesF(0);setPernocteF(0);setViaticosF(0);};

  const selVeh=(id:string)=>{
    setForm(p=>({...p,vehiculo_flota_id:id}));
    if(!id)return;
    const v=flota.find(v=>v.id===Number(id));
    if(!v)return;
    setForm(p=>({...p,vehiculo_flota_id:id,equipamiento:v.equipamiento||"full_equipo"}));
    if(items[0]&&!items[0].descripcion&&v.placa)setItems(prev=>{const n=[...prev];n[0]={...n[0],descripcion:`Servicio de transporte — ${v.placa} ${v.categoria||""} ${v.marca||""} (${v.capacidad_pasajeros||"—"} pax)`};return n;});
  };

  const aplicarPrecio=(sinIGV:number,fuente:string,costoBase?:number)=>{
    const esFijo=form.modo_servicio==="fijo";
    const conIGV=sinIGV*(1+IGV);
    setItems(prev=>{
      const n=[...prev];
      n[0]={...n[0],precio_unit:Math.round(sinIGV*100)/100,
        descripcion:n[0].descripcion||`${esFijo?"Transporte fijo":"Servicio"} — ${form.origen}→${form.destino}`};
      return n;
    });
    if(costoBase)setForm(p=>({...p,costo_estimado:String(Math.round(costoBase*100)/100)}));
    if(esFijo){
      setForm(p=>({...p,precio_dia:String(Math.round(conIGV*100)/100)}));
    }
  };

  const buscarTarifa=()=>tarifas.find(t=>norm(t.origen)===norm(form.origen)&&norm(t.destino)===norm(form.destino)&&t.tipo_vehiculo===form.tipo_vehiculo&&t.equipamiento===form.equipamiento&&t.tipo_servicio===form.tipo_servicio&&(t.modo||"eventual")===form.modo_servicio)||null;

  const guardarCotizacion=async()=>{
    if(!form.cliente_id||!form.origen||!form.destino){alert("Selecciona cliente, origen y destino");return;}
    const cl=clientes.find(c=>c.id===Number(form.cliente_id));
    if(cl?.estado==="bloqueado"){alert("Cliente bloqueado.");return;}
    if(items.some(it=>!it.descripcion.trim())){alert("Todos los items necesitan descripción");return;}
    setGuardando(true);

    const tarifaEnc=buscarTarifa();
    const kmNum=Number(form.km)||0;
    const esFijo=form.modo_servicio==="fijo";
    const costoCalc=calcCosto(form.tipo_vehiculo,kmNum>0?kmNum:1,diasCond,peajesF,pernocteF,viaticosF);
    const precioDiaNum=esFijo?Number(form.precio_dia)||costoCalc?.diaEstIGV:null;
    const precioMesNum=esFijo&&precioDiaNum?precioDiaNum*26:null;

    const payload={
      cliente_id:Number(form.cliente_id),origen:form.origen.trim(),destino:form.destino.trim(),
      km:kmNum,precio_cliente:esFijo?(precioDiaNum||total):total,
      costo_estimado:Number(form.costo_estimado||0),
      margen_estimado:esFijo?((precioDiaNum||0)-Number(form.costo_estimado||0)):(total-Number(form.costo_estimado||0)),
      estado:form.estado,numero_cotizacion:form.numero_cotizacion.trim()||null,
      atencion:form.atencion.trim()||null,asunto:form.asunto.trim()||null,
      punto_retorno:form.punto_retorno.trim()||null,
      fecha_servicio:form.fecha_servicio||null,hora_ida:form.hora_ida||null,
      hora_retorno:form.hora_retorno||null,descuento_pct:Number(form.descuento_pct||0),
      items_json:items,tipo_vehiculo:form.tipo_vehiculo||null,
      tipo_servicio:form.tipo_servicio||null,equipamiento:form.equipamiento||null,
      vehiculo_flota_id:form.vehiculo_flota_id?Number(form.vehiculo_flota_id):null,
      consideraciones_json:consid,
      paradas_json:paradas.length>0?paradas:null,
      // Modo y campos nuevos
      modo_servicio:form.modo_servicio,
      dias_servicio:Number(form.dias_servicio)||1,
      horas_servicio:Number(form.horas_servicio)||8,
      pernocte_costo:pernocteF||null,
      precio_dia:precioDiaNum,
      precio_mes_estimado:precioMesNum,
      // Pricing inteligente
      precio_tarifario:tarifaEnc?tarifaEnc.precio:null,
      precio_cotizador:esFijo?(costoCalc?.diaEstIGV||null):(costoCalc?.totalEst20||null),
      costo_cotizador:costoCalc?.baseCosto||null,
      margen_cotizador:20,
      vehiculo_cotizador:FLOTA_COSTOS[form.tipo_vehiculo]?.nombre||null,
      precio_sugerido:costoCalc?(esFijo?costoCalc.diaEstIGV:costoCalc.totalEst20):null,
      modo_precio:tarifaEnc?"tarifario":"cotizador",
    };

    const{error}=editandoId
      ?await supabase.from("cotizaciones").update(payload).eq("id",editandoId)
      :await supabase.from("cotizaciones").insert(payload);
    if(error){alert(error.message);setGuardando(false);return;}

    if(guardarTar&&form.tipo_vehiculo&&form.tipo_servicio&&form.equipamiento&&subtotal>0){
      await supabase.from("tarifario").upsert({
        origen:form.origen.trim().toUpperCase(),destino:form.destino.trim().toUpperCase(),
        tipo_vehiculo:form.tipo_vehiculo,equipamiento:form.equipamiento,
        tipo_servicio:form.tipo_servicio,modo:form.modo_servicio,
        precio:esFijo?(precioDiaNum||subtotal)/1.18:subtotal,moneda:"PEN",
        confidencial:["full_day","multi_dia"].includes(form.tipo_servicio),
        incluye_guia:false,incluye_peajes:false,incluye_alimentacion:false,
        notas:`Cotización ${form.numero_cotizacion||""}`.trim(),activo:true,
      },{onConflict:"origen,destino,tipo_vehiculo,equipamiento,tipo_servicio"});
    }
    limpiar();cargar();setGuardando(false);
  };

  const cambiarEstado=async(cot:Cotizacion,nEst:EstadoCot)=>{
    if(nEst==="aprobado"&&cot.estado!=="aprobado"){setModalAprob(cot);return;}
    await supabase.from("cotizaciones").update({estado:nEst}).eq("id",cot.id);cargar();
  };

  const confirmarAprob=async(tipo:string,numero:string)=>{
    if(!modalAprob)return;
    await supabase.from("cotizaciones").update({estado:"aprobado",tipo_aprobacion:tipo,numero_aprobacion:numero}).eq("id",modalAprob.id);
    if(modalAprob.tipo_vehiculo&&modalAprob.tipo_servicio&&modalAprob.equipamiento){
      const esFijo=modalAprob.modo_servicio==="fijo";
      await supabase.from("tarifario").upsert({
        origen:modalAprob.origen.toUpperCase(),destino:modalAprob.destino.toUpperCase(),
        tipo_vehiculo:modalAprob.tipo_vehiculo,equipamiento:modalAprob.equipamiento,
        tipo_servicio:modalAprob.tipo_servicio,modo:modalAprob.modo_servicio||"eventual",
        precio:esFijo?(Number(modalAprob.precio_dia||0)/1.18):Math.round(Number(modalAprob.precio_cliente)/1.18*100)/100,
        moneda:"PEN",confidencial:["full_day","multi_dia"].includes(modalAprob.tipo_servicio||""),
        incluye_guia:false,incluye_peajes:false,incluye_alimentacion:false,
        notas:`Aprobada #${modalAprob.numero_cotizacion||modalAprob.id}`,activo:true,
      },{onConflict:"origen,destino,tipo_vehiculo,equipamiento,tipo_servicio"});
    }
    setModalAprob(null);cargar();
  };

  const convertirAReserva=async(cot:Cotizacion)=>{
    if(cot.estado!=="aprobado"){alert("Solo cotizaciones aprobadas");return;}
    const{data:existe}=await supabase.from("reservas").select("id").eq("cotizacion_id",cot.id).maybeSingle();
    if(existe){alert("Ya fue convertida en reserva");return;}
    const ps=cot.paradas_json||[];
    const pI=ps.find(p=>p.tipo==="inicio"); const pD=ps.find(p=>p.tipo==="destino");
    const{data:r,error}=await supabase.from("reservas").insert({
      cliente_id:cot.cliente_id,cotizacion_id:cot.id,
      origen:pI?.nombre||cot.origen,destino:pD?.nombre||cot.destino,
      precio_cliente:cot.precio_cliente,costo_proveedor:0,
      fecha_servicio:cot.fecha_servicio||new Date().toISOString().split("T")[0],
      hora_servicio:pI?.hora||cot.hora_ida||"06:00",
      estado:"pendiente",tipo:"propia",tipo_servicio_detalle:cot.tipo_servicio||null,
      paradas_json:cot.paradas_json||null,
    }).select().single();
    if(error){alert(error.message);return;}
    if(ps.length>0&&r){
      await supabase.from("paradas").insert([...ps.filter(p=>p.tipo==="inicio"),...ps.filter(p=>p.tipo==="intermedia"),...ps.filter(p=>p.tipo==="destino")].map((p,i)=>({
        reserva_id:r.id,orden:i+1,nombre:p.nombre,direccion:p.direccion||null,
        lat:p.lat?Number(p.lat):null,lng:p.lng?Number(p.lng):null,hora_estimada:p.hora||null,estado:"pendiente",
      })));
    }
    alert(`✅ Reserva creada${ps.length>0?` con ${ps.length} paradas`:""}`);cargar();
  };

  const editarCot=(c:Cotizacion)=>{
    setForm({
      cliente_id:String(c.cliente_id||""),origen:c.origen||"",destino:c.destino||"",
      km:c.km?String(c.km):"",costo_estimado:c.costo_estimado?String(c.costo_estimado):"",
      estado:c.estado||"pendiente",numero_cotizacion:c.numero_cotizacion||"",
      atencion:c.atencion||"",asunto:c.asunto||"",punto_retorno:c.punto_retorno||"",
      fecha_servicio:c.fecha_servicio||"",hora_ida:c.hora_ida||"",hora_retorno:c.hora_retorno||"",
      descuento_pct:c.descuento_pct?String(c.descuento_pct):"0",
      tipo_vehiculo:c.tipo_vehiculo||"BUS_49",equipamiento:c.equipamiento||"full_equipo",
      vehiculo_flota_id:c.vehiculo_flota_id?String(c.vehiculo_flota_id):"",
      modo_servicio:(c.modo_servicio||"eventual") as ModoServ,
      tipo_servicio:c.tipo_servicio||"solo_ida",
      dias_servicio:String(c.dias_servicio||1),horas_servicio:String(c.horas_servicio||8),
      pernocte_costo:String(c.pernocte_costo||0),precio_dia:c.precio_dia?String(c.precio_dia):"",
    });
    if(c.items_json?.length)setItems(c.items_json);
    else{const p=Number(c.precio_cliente||0)/1.18;setItems([{descripcion:c.asunto||`${c.origen}→${c.destino}`,dias:1,cantidad:1,precio_unit:Math.round(p*100)/100,descuento_pct:0}]);}
    setConsid(c.consideraciones_json||DEFAULT_CONSID);
    setParadas(c.paradas_json||[]);setEditandoId(c.id);setMostrarForm(true);
    setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50);
  };

  const abrirPDF=(cot:Cotizacion)=>{
    const cl=clientes.find(c=>c.id===cot.cliente_id);
    const veh=flota.find(v=>v.id===cot.vehiculo_flota_id);
    const its=cot.items_json?.length?cot.items_json:[{descripcion:`${cot.asunto||"SERVICIO"} — ${cot.origen}→${cot.destino}`,dias:1,cantidad:1,precio_unit:cot.precio_cliente/1.18,descuento_pct:0}];
    generarPDF(cot,cl,its,veh,reprNombre,cot.consideraciones_json||consid);
  };

  // KPIs
  const totC=cotizas.length;
  const pend=cotizas.filter(c=>c.estado==="pendiente").length;
  const env=cotizas.filter(c=>c.estado==="enviado").length;
  const apr=cotizas.filter(c=>c.estado==="aprobado").length;
  const valT=cotizas.reduce((s,c)=>s+Number(c.precio_cliente||0),0);
  const tasa=totC>0?Math.round(apr/totC*100):0;
  const pendDesc=cotizas.filter(c=>c.descuento_solicitado&&!c.descuento_autorizado).length;

  const nomCl=(id:number|null)=>{const c=clientes.find(cl=>cl.id===id);return c?(c.nombre+(c.empresa&&c.empresa!==c.nombre?` (${c.empresa})`:"")):"Sin cliente";};

  const filtradas=cotizas.filter(c=>{
    const ncl=clientes.find(cl=>cl.id===c.cliente_id);
    const q=busqueda.toLowerCase();
    return((ncl?.nombre||"").toLowerCase().includes(q)||c.origen.toLowerCase().includes(q)||c.destino.toLowerCase().includes(q)||(c.numero_cotizacion||"").includes(q))&&
      (filtroEst==="todos"||c.estado===filtroEst)&&
      (filtroModo==="todos"||c.modo_servicio===filtroModo||(filtroModo==="eventual"&&!c.modo_servicio));
  });

  const kmNum=Number(form.km)||0;
  const vehFloraSel=flota.find(v=>v.id===Number(form.vehiculo_flota_id));
  const servsList=form.modo_servicio==="eventual"?SERVS_EVENTUAL:SERVS_FIJO;
  const esFijoForm=form.modo_servicio==="fijo";

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <>
      {modalAprob&&<ModalAprobacion cot={modalAprob} onConfirmar={confirmarAprob} onCancelar={()=>setModalAprob(null)}/>}
      <main className="p-6 space-y-5 max-w-7xl mx-auto">

        {/* ENCABEZADO */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Cotizaciones</h1>
            <p className="text-sm text-gray-400 mt-1">
              EVENTUAL (por evento) y FIJO (por día · contratos de personal)
              {pendDesc>0&&<span className="ml-2 inline-flex items-center gap-1 text-orange-600 font-bold bg-orange-50 px-2 py-0.5 rounded-full text-xs">🙋 {pendDesc} descuento{pendDesc>1?"s":""} pendiente{pendDesc>1?"s":""}</span>}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <a href="/cotizador" className="px-4 py-2.5 rounded-xl font-bold text-sm border text-[#0b315f] border-[#0b315f] hover:bg-[#eef3f8] transition-colors">🔧 Cotizador avanzado</a>
            <button onClick={()=>{limpiar();setMostrarForm(v=>!v);}}
              className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
              style={{background:mostrarForm?"#6b7280":"#0b315f"}}>
              {mostrarForm?"✕ Cancelar":"+ Nueva cotización"}
            </button>
          </div>
        </div>

        {/* KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          {[
            {label:"Total",         val:totC,                 color:"#0b315f",bg:"#eef3f8"},
            {label:"Eventuales",    val:cotizas.filter(c=>!c.modo_servicio||c.modo_servicio==="eventual").length,color:"#0b315f",bg:"#eef3f8"},
            {label:"Fijos",         val:cotizas.filter(c=>c.modo_servicio==="fijo").length,color:"#166534",bg:"#dcfce7"},
            {label:"Pendientes",    val:pend,                 color:"#854d0e",bg:"#fef9c3"},
            {label:"Enviadas",      val:env,                  color:"#0369a1",bg:"#e0f2fe"},
            {label:"Aprobadas",     val:apr,                  color:"#166534",bg:"#dcfce7"},
            {label:"Tasa",          val:`${tasa}%`,           color:"#1d4ed8",bg:"#dbeafe"},
            {label:"Dscto. pend.",  val:pendDesc,             color:"#d97706",bg:"#fef3c7"},
          ].map(k=>(
            <div key={k.label} className="rounded-xl p-3 border" style={{background:k.bg,borderColor:k.color+"22"}}>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{color:k.color+"99"}}>{k.label}</p>
              <p className="text-xl font-black mt-0.5" style={{color:k.color}}>{k.val}</p>
            </div>
          ))}
        </section>

        {/* FORMULARIO */}
        {mostrarForm&&(
          <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{background:"#0b315f"}}>{editandoId?"✏️":"📄"}</div>
              <div>
                <h2 className="text-lg font-bold">{editandoId?"Editar cotización":"Nueva cotización"}</h2>
                <p className="text-xs text-gray-400">Precio calculado en tiempo real · EVENTUAL (por evento) o FIJO (por día)</p>
              </div>
            </div>

            {/* MODO EVENTUAL / FIJO */}
            <div className="grid grid-cols-2 gap-3">
              {[
                {id:"eventual",label:"📋 EVENTUAL",sub:"Precio total por evento · Cotización / OS",color:"#0b315f",bg:"#eef3f8"},
                {id:"fijo",    label:"📅 FIJO",    sub:"Precio por día · Contrato mensual",       color:"#166534",bg:"#dcfce7"},
              ].map(m=>(
                <button key={m.id} onClick={()=>{setForm(p=>({...p,modo_servicio:m.id as ModoServ,tipo_servicio:m.id==="eventual"?"solo_ida":"transporte_personal"}));}}
                  className="flex flex-col items-start px-4 py-3 rounded-xl border-2 transition-all text-left"
                  style={{background:form.modo_servicio===m.id?m.bg:"white",borderColor:form.modo_servicio===m.id?m.color:"#e5e7eb",color:form.modo_servicio===m.id?m.color:"#9ca3af"}}>
                  <p className="font-black text-base">{m.label}</p>
                  <p className="text-[11px] opacity-70">{m.sub}</p>
                </button>
              ))}
            </div>

            {/* Identificación */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Cliente" req>
                  <div className="flex gap-2">
                    <select className={iCls()} value={form.cliente_id} onChange={f("cliente_id")}>
                      <option value="">— Seleccionar cliente ({clientes.length}) —</option>
                      {clientes.filter(c=>c.estado!=="bloqueado").sort((a,b)=>a.nombre.localeCompare(b.nombre)).map(c=>(
                        <option key={c.id} value={c.id}>{c.nombre}{c.empresa&&c.empresa!==c.nombre?` (${c.empresa})`:""}{c.ruc?` · RUC ${c.ruc}`:c.dni?` · DNI ${c.dni}`:""}</option>
                      ))}
                    </select>
                    <a href="/clientes" target="_blank" rel="noreferrer" className="flex-shrink-0 w-10 h-10 rounded-xl border-2 flex items-center justify-center font-black text-lg" style={{background:"#eef3f8",borderColor:"#0b315f33",color:"#0b315f"}}>+</a>
                  </div>
                </Campo>
                <Campo label="N° cotización"><input className={iCls("font-mono")} placeholder="Ej: 10996" value={form.numero_cotizacion} onChange={f("numero_cotizacion")}/></Campo>
                <Campo label="Estado">
                  <select className={iCls()} value={form.estado} onChange={f("estado")}>
                    <option value="pendiente">Pendiente</option><option value="enviado">Enviado</option><option value="rechazado">Rechazado</option>
                  </select>
                </Campo>
                <Campo label="Atención" span={2}><input className={iCls()} placeholder="Nombre del responsable del cliente" value={form.atencion} onChange={f("atencion")}/></Campo>
                <Campo label="Asunto"><input className={iCls()} placeholder="Ej: Traslado aeropuerto" value={form.asunto} onChange={f("asunto")}/></Campo>
              </div>
            </div>

            {/* Tipo de servicio */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
                Tipo de servicio — {esFijoForm?"FIJO (Transporte de Personal)":"EVENTUAL"}
              </p>
              {/* Grupos */}
              {Object.entries(
                servsList.reduce((acc,s)=>{(acc[s.cat]||(acc[s.cat]=[])).push(s);return acc;},{} as Record<string,typeof servsList>)
              ).map(([cat,servs])=>(
                <div key={cat} className="mb-3">
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1.5">{cat}</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {servs.map(s=>{const act=form.tipo_servicio===s.id;return(
                      <button key={s.id} onClick={()=>setForm(p=>({...p,tipo_servicio:s.id}))}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 transition-all text-left"
                        style={{background:act?(esFijoForm?"#dcfce7":"#eef3f8"):"white",borderColor:act?(esFijoForm?"#166534":"#0b315f"):"#e5e7eb",color:act?(esFijoForm?"#166534":"#0b315f"):"#9ca3af"}}>
                        <span className="font-bold text-sm">{s.label}</span>
                      </button>
                    );})}
                  </div>
                </div>
              ))}

              {/* Equipamiento */}
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mt-3 mb-1.5">Tipo de movilidad</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  {val:"full_equipo",label:"⭐ Full Equipo",sub:"AC, TV, USB, GPS cliente",color:"#0b315f",bg:"#eef3f8"},
                  {val:"basico",     label:"📦 Básico",     sub:"Estándar — cumple ley",  color:"#4b5563",bg:"#f3f4f6"},
                ].map(e=>{const act=form.equipamiento===e.val;return(
                  <button key={e.val} onClick={()=>setForm(p=>({...p,equipamiento:e.val}))}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all"
                    style={{background:act?e.bg:"white",borderColor:act?e.color:"#e5e7eb",color:act?e.color:"#9ca3af"}}>
                    <div><p className="font-bold text-xs">{e.label}</p><p className="text-[10px] opacity-70">{e.sub}</p></div>
                  </button>
                );})}
              </div>

              {/* Vehículo */}
              <div className="grid grid-cols-4 md:grid-cols-7 gap-1.5 mt-2">
                {TIPOS_VEH.map(t=>{const act=form.tipo_vehiculo===t.id;return(
                  <button key={t.id} onClick={()=>setForm(p=>({...p,tipo_vehiculo:t.id}))}
                    className="flex flex-col items-center gap-0.5 px-1 py-2 rounded-xl border-2 transition-all"
                    style={{background:act?"#eef3f8":"white",borderColor:act?"#0b315f":"#e5e7eb",color:act?"#0b315f":"#9ca3af"}}>
                    <span className="text-base">{t.icon}</span>
                    <span className="text-[8px] font-bold leading-tight text-center">{t.label}</span>
                  </button>
                );})}
              </div>
            </div>

            {/* Unidad de flota */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
                Unidad de flota <span className="normal-case font-normal text-blue-500">→ fotos y características en PDF</span>
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="Vehículo específico (opcional)" hint="Incluirá fotos y características en el PDF">
                  <select className={iCls()} value={form.vehiculo_flota_id} onChange={e=>selVeh(e.target.value)}>
                    <option value="">Sin vehículo específico</option>
                    {flota.map(v=><option key={v.id} value={v.id}>{v.placa} — {v.categoria} {v.marca} {v.modelo} {v.capacidad_pasajeros?`(${v.capacidad_pasajeros}p)`:""} · {v.equipamiento==="full_equipo"?"⭐ Full":"📦 Básico"}{v.foto_externa_url?" · 📸":""}</option>)}
                  </select>
                </Campo>
                {vehFloraSel&&(
                  <div className="rounded-xl border-2 p-3" style={{background:"#eef3f8",borderColor:"#0b315f33"}}>
                    <p className="text-[10px] font-bold uppercase text-[#0b315f] mb-1">✅ Seleccionado</p>
                    <p className="font-black text-[#0b315f] font-mono">{vehFloraSel.placa}</p>
                    <p className="text-xs text-gray-500">{vehFloraSel.marca} {vehFloraSel.modelo}</p>
                    <div className="flex gap-2 text-[10px] mt-1">
                      {vehFloraSel.foto_externa_url&&<span className="text-green-600 font-bold">📸 Exterior ✓</span>}
                      {vehFloraSel.foto_interna_url&&<span className="text-green-600 font-bold">📸 Interior ✓</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Ruta */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Ruta del servicio</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Punto de recojo" req><input className={iCls()} placeholder="Av. República de Panamá 3623" value={form.origen} onChange={f("origen")}/></Campo>
                <Campo label="Punto de destino" req><input className={iCls()} placeholder="Planta Cajamarquilla" value={form.destino} onChange={f("destino")}/></Campo>
                <Campo label="Punto de retorno"><input className={iCls()} placeholder="Igual al origen si aplica" value={form.punto_retorno} onChange={f("punto_retorno")}/></Campo>
                <Campo label="Fecha de servicio"><input type="date" className={iCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")}/></Campo>
                <Campo label="Hora de ida"><input type="time" className={iCls()} value={form.hora_ida} onChange={f("hora_ida")}/></Campo>
                <Campo label="Hora de retorno"><input type="time" className={iCls()} value={form.hora_retorno} onChange={f("hora_retorno")}/></Campo>
              </div>
            </div>

            {/* Parámetros de costing */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
                Parámetros de costing
                <span className="normal-case font-normal text-[#0b315f] ml-2">→ el precio se calcula automáticamente</span>
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Campo label={esFijoForm?"Km diarios (ida+vuelta)":"Km del servicio"} req>
                  <input type="number" min={0} className={iCls("font-mono")} placeholder="0" value={form.km} onChange={f("km")}/>
                </Campo>
                <Campo label={esFijoForm?"Días de contrato":"Días de conductor"}>
                  <div className="flex items-center gap-1">
                    <button onClick={()=>setDiasCond(Math.max(1,diasCond-1))} className="w-9 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold text-gray-600 flex-shrink-0">-</button>
                    <span className="flex-1 text-center font-black text-[#0b315f]">{diasCond}</span>
                    <button onClick={()=>setDiasCond(Math.min(30,diasCond+1))} className="w-9 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold text-gray-600 flex-shrink-0">+</button>
                  </div>
                </Campo>
                <Campo label="Peajes S/" hint="Total de peajes estimado">
                  <input type="number" min={0} className={iCls()} placeholder="0" value={peajesF||""} onChange={e=>setPeajesF(Number(e.target.value))}/>
                </Campo>
                <Campo label="Costo interno S/" hint="Para calcular margen real">
                  <input type="number" min={0} className={iCls()} placeholder="0" value={form.costo_estimado} onChange={f("costo_estimado")}/>
                </Campo>
              </div>

              {/* Multi-día extras */}
              {!esFijoForm&&form.tipo_servicio==="multi_dia"&&(
                <div className="mt-3 rounded-xl bg-purple-50 border border-purple-200 p-4 grid grid-cols-2 gap-4">
                  <p className="col-span-2 text-[10px] font-black text-purple-700 uppercase tracking-wider">🏕️ Costos adicionales multi-día</p>
                  <Campo label="Pernocte bus S/">
                    <input type="number" min={0} className={iCls()} placeholder="0" value={pernocteF||""} onChange={e=>setPernocteF(Number(e.target.value))}/>
                  </Campo>
                  <Campo label="Viáticos chofer S/">
                    <input type="number" min={0} className={iCls()} placeholder="0" value={viaticosF||""} onChange={e=>setViaticosF(Number(e.target.value))}/>
                  </Campo>
                </div>
              )}

              {/* Precio día para FIJO */}
              {esFijoForm&&(
                <div className="mt-3 rounded-xl bg-green-50 border border-green-200 p-4 grid grid-cols-2 gap-4 items-end">
                  <Campo label="Precio/día confirmado S/ (con IGV)" hint="Se calcula automáticamente o puedes ajustarlo">
                    <input type="number" min={0} className={iCls("font-mono font-bold")} placeholder="0.00" value={form.precio_dia} onChange={f("precio_dia")}/>
                  </Campo>
                  {form.precio_dia&&Number(form.precio_dia)>0&&(
                    <div className="rounded-xl bg-green-100 border border-green-300 px-4 py-3">
                      <p className="text-[10px] font-bold text-green-700 uppercase">Estimado mensual (×26 días)</p>
                      <p className="font-black text-xl text-green-700">{fmtS(Number(form.precio_dia)*26)}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* CALCULADOR EN VIVO */}
            <SugerenciaEnVivo
              origen={form.origen} destino={form.destino}
              tipoVeh={form.tipo_vehiculo} tipoServ={form.tipo_servicio}
              equip={form.equipamiento} km={kmNum}
              dias={diasCond} peajes={peajesF}
              pernocte={pernocteF} viaticos={viaticosF}
              modoServ={form.modo_servicio}
              tarifas={tarifas} onAplicar={aplicarPrecio}
            />

            {/* Items */}
            <div>
              <div className="flex items-center justify-between border-b pb-1 mb-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  Items del servicio {esFijoForm&&"(precio/día)"}
                </p>
                <button onClick={addItem} className="text-xs font-bold text-[#0b315f] hover:underline">+ Agregar item</button>
              </div>
              <div className="space-y-2">
                <div className="hidden md:grid grid-cols-12 gap-2 text-[10px] font-bold uppercase tracking-wide text-gray-400 px-2">
                  <div className="col-span-4">Descripción</div><div className="col-span-1 text-center">Días</div>
                  <div className="col-span-1 text-center">Cant.</div><div className="col-span-2 text-right">P. Unit S/ sin IGV</div>
                  <div className="col-span-1 text-center">% Dscto</div><div className="col-span-2 text-right">Total S/</div><div className="col-span-1"></div>
                </div>
                {items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return(
                  <div key={i} className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-xl p-2">
                    <div className="col-span-12 md:col-span-4"><input className={iCls()} placeholder="Ej: Transporte en Bus 49 PAX" value={it.descripcion} onChange={e=>updItem(i,"descripcion",e.target.value)}/></div>
                    <div className="col-span-4 md:col-span-1"><input type="number" min="1" className={iCls("text-center")} value={it.dias} onChange={e=>updItem(i,"dias",e.target.value)}/></div>
                    <div className="col-span-4 md:col-span-1"><input type="number" min="1" className={iCls("text-center")} value={it.cantidad} onChange={e=>updItem(i,"cantidad",e.target.value)}/></div>
                    <div className="col-span-4 md:col-span-2"><input type="number" min="0" className={iCls("text-right")} placeholder="0.00" value={it.precio_unit||""} onChange={e=>updItem(i,"precio_unit",e.target.value)}/></div>
                    <div className="col-span-4 md:col-span-1"><input type="number" min="0" max="100" className={iCls("text-center")} placeholder="0" value={it.descuento_pct||""} onChange={e=>updItem(i,"descuento_pct",e.target.value)}/></div>
                    <div className="col-span-6 md:col-span-2 text-right font-bold text-sm text-gray-800 pr-2">{fmtS(tf)}</div>
                    <div className="col-span-2 md:col-span-1 flex justify-end">{items.length>1&&<button onClick={()=>delItem(i)} className="w-7 h-7 rounded-lg text-red-400 hover:bg-red-50 font-bold text-sm">✕</button>}</div>
                  </div>
                );})}
              </div>
              <div className="flex justify-end mt-4">
                <div className="w-72 space-y-1.5 bg-gray-50 rounded-xl p-4">
                  <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal (sin IGV)</span><span className="font-bold">{fmtS(subtotal)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-500">IGV 18%</span><span className="font-bold">{fmtS(igv)}</span></div>
                  <div className="flex justify-between text-base border-t pt-2" style={{borderColor:"#0b315f"}}>
                    <span className="font-black">{esFijoForm?"Total/día":"Total neto"}</span>
                    <span className="font-black" style={{color:"#0b315f"}}>{fmtS(total)}</span>
                  </div>
                  {esFijoForm&&<div className="flex justify-between text-sm"><span className="text-gray-400">Estimado mensual (×26)</span><span className="font-black text-green-600">{fmtS(total*26)}</span></div>}
                  {form.costo_estimado&&Number(form.costo_estimado)>0&&(
                    <div className="flex justify-between text-xs"><span className="text-gray-400">Margen estimado</span><span className={`font-bold ${total-Number(form.costo_estimado)>=0?"text-green-600":"text-red-500"}`}>{fmtS(total-Number(form.costo_estimado))}</span></div>
                  )}
                </div>
              </div>
            </div>

            {/* Consideraciones */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Consideraciones <span className="normal-case font-normal text-blue-500">→ aparecen en el PDF</span></p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {([{key:"incluye" as const,label:"✅ Servicio incluye",color:"#166534",bg:"#f0fdf4",border:"#86efac"},{key:"no_incluye" as const,label:"❌ No incluye",color:"#991b1b",bg:"#fff5f5",border:"#fca5a5"}]).map(({key,label,color,bg,border})=>(
                  <div key={key} className="rounded-xl border-2 p-3 space-y-2" style={{background:bg,borderColor:border}}>
                    <p className="text-xs font-black" style={{color}}>{label}</p>
                    <div className="space-y-1.5">
                      {consid[key].map((item,i)=>(
                        <div key={i} className="flex gap-2 items-center">
                          <input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white" value={item}
                            onChange={e=>setConsid(prev=>({...prev,[key]:prev[key].map((it,idx)=>idx===i?e.target.value:it)}))}/>
                          <button onClick={()=>setConsid(prev=>({...prev,[key]:prev[key].filter((_,idx)=>idx!==i)}))} className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button>
                        </div>
                      ))}
                    </div>
                    <button onClick={()=>setConsid(prev=>({...prev,[key]:[...prev[key],""]}))  } className="text-[10px] font-bold hover:underline" style={{color}}>+ Agregar ítem</button>
                  </div>
                ))}
              </div>

              {/* Consideraciones generales — editable */}
              <div className="rounded-xl border-2 p-3 space-y-2 mt-4" style={{background:"#eef3f8",borderColor:"#93c5fd"}}>
                <p className="text-xs font-black text-[#0b315f]">📋 Consideraciones generales</p>
                <div className="space-y-1.5">
                  {consid.generales.map((item,i)=>(
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white"
                        value={item}
                        onChange={e=>setConsid(prev=>({...prev,generales:prev.generales.map((it,idx)=>idx===i?e.target.value:it)}))}
                      />
                      <button
                        onClick={()=>setConsid(prev=>({...prev,generales:prev.generales.filter((_,idx)=>idx!==i)}))}
                        className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-4">
                  <button
                    onClick={()=>setConsid(prev=>({...prev,generales:[...prev.generales,""]}))}
                    className="text-[10px] font-bold text-[#0b315f] hover:underline">
                    + Agregar ítem
                  </button>
                  <button
                    onClick={()=>setConsid(prev=>({...prev,generales:[...DEFAULT_CONSID.generales]}))}
                    className="text-[10px] text-gray-400 hover:underline">
                    ↺ Restaurar por defecto
                  </button>
                </div>
              </div>
            </div>

            {/* Paradas */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
                {esFijoForm?"🚏 Paraderos del recorrido":"📍 Puntos del recorrido"}
              </p>
              <ParadasBuilder paradas={paradas} onChange={setParadas} tipo={form.tipo_servicio}/>
            </div>

            {/* Guardar en tarifario */}
            {form.tipo_vehiculo&&form.tipo_servicio&&form.origen&&form.destino&&(
              <div className="rounded-xl border px-4 py-3 flex items-start gap-3" style={{background:"#f0fdf4",borderColor:"#86efac"}}>
                <input type="checkbox" id="chk_tar" checked={guardarTar} onChange={e=>setGuardarTar(e.target.checked)} className="w-4 h-4 mt-0.5 accent-green-600 flex-shrink-0"/>
                <label htmlFor="chk_tar" className="cursor-pointer text-xs text-green-800">
                  <b>Guardar en Tarifario</b> — {form.origen}→{form.destino} · {TIPOS_VEH.find(v=>v.id===form.tipo_vehiculo)?.label} · {form.modo_servicio.toUpperCase()} · {servsList.find(s=>s.id===form.tipo_servicio)?.label}
                  {esFijoForm&&<span className="ml-1">(guardará precio/día)</span>}
                </label>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={guardarCotizacion} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{background:"#0b315f"}}>
                {guardando?"Guardando...":editandoId?"Actualizar cotización":"Guardar cotización"}
              </button>
              <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
            </div>
          </section>
        )}

        {/* FILTROS */}
        <section className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none" placeholder="Buscar cliente, ruta o N°..." value={busqueda} onChange={e=>setBusqueda(e.target.value)}/>
          </div>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroModo} onChange={e=>setFiltroModo(e.target.value)}>
            <option value="todos">Eventual + Fijo</option>
            <option value="eventual">Solo Eventual</option>
            <option value="fijo">Solo Fijo</option>
          </select>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e=>setFiltroEst(e.target.value)}>
            <option value="todos">Todos los estados</option>
            <option value="pendiente">Pendientes</option><option value="enviado">Enviadas</option>
            <option value="aprobado">Aprobadas</option><option value="rechazado">Rechazadas</option>
          </select>
          <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">{filtradas.length} resultados</div>
        </section>

        {/* TABLA */}
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0"}}>
                  {["N°","Cliente","Ruta","Vehículo","Servicio","Fecha","Precio","Margen","Estado","Acciones"].map(h=>(
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading?(
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400"><div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>Cargando...</div></td></tr>
                ):filtradas.length===0?(
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">📄</p><p>No hay cotizaciones</p></td></tr>
                ):filtradas.map(c=>{
                  const est=ESTADO_CFG[c.estado]||ESTADO_CFG.pendiente;
                  const margen=Number(c.margen_estimado||0);
                  const veh=TIPOS_VEH.find(v=>v.id===c.tipo_vehiculo);
                  const vehF=flota.find(v=>v.id===c.vehiculo_flota_id);
                  const tieneDec=!!(c.precio_cotizador||c.precio_tarifario);
                  const tieneDsc=c.descuento_solicitado&&!c.descuento_autorizado;
                  const esFijo=c.modo_servicio==="fijo";
                  const servLabel=[...SERVS_EVENTUAL,...SERVS_FIJO].find(s=>s.id===c.tipo_servicio)?.label||c.tipo_servicio||"";
                  return(
                    <React.Fragment key={c.id}>
                      <tr className={`border-t hover:bg-gray-50 ${tieneDsc?"bg-orange-50":""}`} style={{borderColor:"#f1f5f9"}}>
                        <td className="p-3 font-mono font-black text-[#0b315f] text-xs">
                          <div>#{c.numero_cotizacion||String(c.id).padStart(5,"0")}</div>
                          <div className={`text-[9px] font-black px-1.5 py-0.5 rounded-full mt-0.5 inline-block ${esFijo?"bg-green-100 text-green-700":"bg-blue-100 text-blue-700"}`}>
                            {esFijo?"📅 FIJO":"📋 EVENTUAL"}
                          </div>
                          {tieneDec&&(
                            <button onClick={()=>setPanelId(panelId===c.id?null:c.id)}
                              className={`block mt-1 text-[9px] font-black px-1.5 py-0.5 rounded-full transition-colors ${tieneDsc?"bg-orange-100 text-orange-700 animate-pulse":"bg-[#eef3f8] text-[#0b315f] hover:bg-blue-100"}`}>
                              {tieneDsc?"🙋 Descuento":"💡 Precios"}
                            </button>
                          )}
                        </td>
                        <td className="p-3 max-w-[120px]"><div className="font-bold text-gray-800 truncate">{nomCl(c.cliente_id)}</div>{c.atencion&&<div className="text-xs text-gray-400 truncate">{c.atencion}</div>}</td>
                        <td className="p-3 max-w-[150px]"><div className="truncate text-gray-700 text-xs">{c.origen}→{c.destino}</div>{c.asunto&&<div className="text-[10px] text-gray-400 truncate">{c.asunto}</div>}</td>
                        <td className="p-3">{vehF?<div><p className="font-mono font-black text-xs text-[#0b315f]">{vehF.placa}</p><p className="text-[10px] text-gray-400">{vehF.equipamiento==="full_equipo"?"⭐":"📦"}</p></div>:veh?<div className="text-xs text-gray-500">{veh.icon} {veh.label}</div>:<span className="text-gray-300 text-xs">—</span>}</td>
                        <td className="p-3"><span className="text-[10px] font-bold text-gray-600">{servLabel}</span>{c.paradas_json&&c.paradas_json.length>0&&<span className="text-[10px] text-[#be185d] font-bold block">🚏 {c.paradas_json.length} paradas</span>}</td>
                        <td className="p-3 text-xs text-gray-500">{fmtF(c.fecha_servicio)}{c.hora_ida&&<div className="text-gray-400">{c.hora_ida}</div>}</td>
                        <td className="p-3 font-bold text-gray-800">
                          {fmtS(Number(c.precio_cliente||0))}
                          {esFijo&&<p className="text-[10px] text-gray-400 font-normal">/día</p>}
                          {esFijo&&c.precio_mes_estimado&&<p className="text-[10px] text-green-600 font-bold">~{fmtS(c.precio_mes_estimado)}/mes</p>}
                          {c.modo_precio&&c.modo_precio!=="manual"&&<p className="text-[9px] text-gray-400 font-normal">{c.modo_precio}</p>}
                        </td>
                        <td className="p-3 font-bold" style={{color:margen>=0?"#166534":"#991b1b"}}>{fmtS(margen)}</td>
                        <td className="p-3" onClick={e=>e.stopPropagation()}>
                          <select value={c.estado} onChange={e=>cambiarEstado(c,e.target.value as EstadoCot)} className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer" style={{background:est.bg,color:est.color}}>
                            <option value="pendiente">Pendiente</option><option value="enviado">Enviado</option><option value="aprobado">Aprobado</option><option value="rechazado">Rechazado</option>
                          </select>
                        </td>
                        <td className="p-3">
                          <div className="flex gap-1 flex-wrap">
                            <button onClick={()=>editarCot(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                            <button onClick={()=>abrirPDF(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border" style={{background:"#eef3f8",color:"#0b315f"}}>📄 PDF</button>
                            <button onClick={()=>convertirAReserva(c)} disabled={c.estado!=="aprobado"} className="px-2 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-30" style={{background:"#dcfce7",color:"#166534"}}>→Res</button>
                          </div>
                        </td>
                      </tr>
                      {panelId===c.id&&(
                        <tr><td colSpan={10} className="px-4 pb-3 pt-0">
                          <PanelDecision c={c} onAct={cargar}/>
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between">
            <span>{filtradas.length} de {totC} cotizaciones · Tasa aprobación: {tasa}%</span>
            <span>AFA ERP · Comercial</span>
          </div>
        </section>
      </main>
    </>
  );
}