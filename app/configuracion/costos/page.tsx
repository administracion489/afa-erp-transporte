"use client";
import React, { useEffect, useState, useMemo } from "react";
import { supabase } from "@/lib/supabase";

type Combustible = {
  id:number; tipo:string; unidad:string; precio:number;
  precio_anterior:number|null; fuente:string;
  fecha_vigencia:string; actualizado_en:string;
  actualizado_por:string|null; notas:string|null;
};
type ParamCosto = {
  id:number; tipo_vehiculo:string; nombre:string; capacidad:number; activo:boolean;
  icono:string|null; grupo_vehiculo:string|null; euronorm:string|null;
  usa_urea:boolean; consumo_urea_pct:number|null;
  tipo_combustible_1:string; rendimiento_1:number; pct_uso_1:number;
  tipo_combustible_2:string|null; rendimiento_2:number|null; pct_uso_2:number|null;
  n_neumaticos:number; costo_neumatico:number; vida_neumatico_km:number;
  mantenimiento_km:number; valor_compra:number; residual_pct:number;
  vida_util_anios:number; km_anio:number;
  seguro_anual:number; soat_anual:number; revision_semestral:number;
  permisos_anual:number; otros_fijos_mensual:number;
  conductor_dia:number; updated_at:string; updated_by:string|null;
};
type Historial = {
  id:number; tabla_origen:string; tipo_vehiculo:string|null; tipo_combustible:string|null;
  campo_modificado:string; valor_anterior:number|null; valor_nuevo:number|null;
  motivo:string|null; cambiado_en:string; cambiado_por:string|null;
};

const EURO_NORMS  = ["Euro II","Euro III","Euro IV","Euro V","Euro VI"];
const EURO_UREA   = ["Euro V","Euro VI"];
const GRUPOS_VEH  = ["Ligeros","Vans","Buses","Otros"];
const ICONOS_VEH  = ["🚗","🚙","🚐","🚌","🏎️","🚚","🚛","🚑"];

const CAMPOS_EDIT: {key:keyof ParamCosto;label:string;grupo:string;unidad:string;step:number;desc?:string}[] = [
  {key:"rendimiento_1",      label:"Rendimiento",        grupo:"Combustible",     unidad:"km/unidad",step:0.5, desc:"Km por galón (Diésel/GLP/Gasolina) o m³ (GNV)"},
  {key:"n_neumaticos",       label:"N° neumáticos",      grupo:"Neumáticos",      unidad:"unid",     step:1},
  {key:"costo_neumatico",    label:"Costo neumático",    grupo:"Neumáticos",      unidad:"S/",       step:50},
  {key:"vida_neumatico_km",  label:"Vida útil",          grupo:"Neumáticos",      unidad:"km",       step:1000},
  {key:"mantenimiento_km",   label:"Mantenimiento",      grupo:"Mantenimiento",   unidad:"S/km",     step:0.05},
  {key:"valor_compra",       label:"Valor de compra",    grupo:"Depreciación",    unidad:"S/",       step:1000},
  {key:"residual_pct",       label:"Valor residual",     grupo:"Depreciación",    unidad:"%",        step:0.01},
  {key:"vida_util_anios",    label:"Vida útil",          grupo:"Depreciación",    unidad:"años",     step:1},
  {key:"km_anio",            label:"Km anuales",         grupo:"Depreciación",    unidad:"km/año",   step:1000},
  {key:"seguro_anual",       label:"Seguro anual",       grupo:"Seguros y fijos", unidad:"S/año",    step:100},
  {key:"soat_anual",         label:"SOAT",               grupo:"Seguros y fijos", unidad:"S/año",    step:50},
  {key:"revision_semestral", label:"Revisión técnica",   grupo:"Seguros y fijos", unidad:"S/rev",    step:50},
  {key:"permisos_anual",     label:"Permisos",           grupo:"Seguros y fijos", unidad:"S/año",    step:100},
  {key:"otros_fijos_mensual",label:"Otros fijos",        grupo:"Seguros y fijos", unidad:"S/mes",    step:50},
  {key:"conductor_dia",      label:"Conductor",          grupo:"Mano de obra",    unidad:"S/día",    step:10},
];
const GRUPOS_CAMPOS = [...new Set(CAMPOS_EDIT.map(c=>c.grupo))];

const COMB_COLOR:Record<string,string> = {Gasolina:"#f97316",Diésel:"#0b315f",GLP:"#8b5cf6",GNV:"#10b981",UREA:"#06b6d4"};
const COMB_BG:Record<string,string>    = {Gasolina:"#fff7ed",Diésel:"#eef3f8",GLP:"#f5f3ff",GNV:"#ecfdf5",UREA:"#ecfeff"};
const GRUPO_CFG:Record<string,{color:string;bg:string}> = {
  Ligeros:{color:"#6366f1",bg:"#eef2ff"},Vans:{color:"#0891b2",bg:"#ecfeff"},
  Buses:{color:"#0b315f",bg:"#eef3f8"},Otros:{color:"#6b7280",bg:"#f3f4f6"},
};

const fmtS  = (n:number) => `S/ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtN  = (n:number,d=2) => n.toLocaleString("es-PE",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtDt = (s:string) => new Date(s).toLocaleString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});

function calcCostoKm(p:ParamCosto,pr:Record<string,number>):number {
  const pc1=pr[p.tipo_combustible_1]||0;
  const combKm=(pc1/p.rendimiento_1)*p.pct_uso_1
    +(p.tipo_combustible_2&&p.rendimiento_2&&p.pct_uso_2?((pr[p.tipo_combustible_2]||0)/p.rendimiento_2)*p.pct_uso_2:0);
  const neumKm=(p.n_neumaticos*p.costo_neumatico)/p.vida_neumatico_km;
  const depKm=(p.valor_compra*(1-p.residual_pct))/(p.vida_util_anios*p.km_anio);
  const fijKm=(p.seguro_anual+p.soat_anual+p.revision_semestral*2+p.permisos_anual+p.otros_fijos_mensual*12)/p.km_anio;
  const ureaKm=p.usa_urea&&p.tipo_combustible_1==="Diésel"
    ?(1/p.rendimiento_1)*3.785*(p.consumo_urea_pct||0.04)*(pr["UREA"]||0):0;
  return combKm+neumKm+p.mantenimiento_km+depKm+fijKm+ureaKm;
}

function CeldaEditable({valor,campo,vehId,onGuardado,unidad,step}:{
  valor:number;campo:keyof ParamCosto;vehId:string;
  onGuardado:(c:string,n:number,a:number)=>void;unidad:string;step:number;
}) {
  const [ed,setEd]=useState(false);
  const [val,setVal]=useState(String(valor));
  const ref=React.useRef<HTMLInputElement>(null);
  const abrir=()=>{setVal(String(valor));setEd(true);setTimeout(()=>ref.current?.focus(),30);};
  const guardar=()=>{const n=Number(val);if(!isNaN(n)&&n!==valor)onGuardado(campo,n,valor);setEd(false);};
  if(ed)return(
    <div className="flex items-center gap-1">
      <input ref={ref} type="number" step={step}
        className="w-24 border-2 border-[#0b315f] rounded-lg px-2 py-1 text-sm font-mono font-bold text-[#0b315f] outline-none"
        value={val} onChange={e=>setVal(e.target.value)}
        onBlur={guardar} onKeyDown={e=>{if(e.key==="Enter")guardar();if(e.key==="Escape")setEd(false);}}/>
      <span className="text-[9px] text-gray-400">{unidad}</span>
    </div>
  );
  return(
    <button onClick={abrir} className="group flex items-center gap-1 hover:bg-blue-50 rounded-lg px-2 py-1 transition-colors w-full text-left">
      <span className="font-mono font-bold text-gray-700 text-sm">{fmtN(valor,step<1?2:0)}</span>
      <span className="text-[9px] text-gray-400">{unidad}</span>
      <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 ml-auto">✏️</span>
    </button>
  );
}

function CombCard({comb,onGuardar}:{comb:Combustible;onGuardar:(n:number)=>void}) {
  const [ed,setEd]=useState(false);
  const [val,setVal]=useState(String(comb.precio));
  const color=COMB_COLOR[comb.tipo]||"#666";
  const bg=COMB_BG[comb.tipo]||"#f9fafb";
  const sube=comb.precio_anterior?comb.precio>comb.precio_anterior:false;
  const dias=comb.actualizado_en?Math.floor((Date.now()-new Date(comb.actualizado_en).getTime())/86400000):0;
  const esUrea=comb.tipo==="UREA";
  const guardar=()=>{const n=parseFloat(val);if(!isNaN(n)&&n>0&&n!==comb.precio)onGuardar(n);setEd(false);};
  return(
    <div className="bg-white rounded-2xl border-2 shadow-sm overflow-hidden hover:shadow-md transition-all" style={{borderColor:color+"33"}}>
      <div className="px-4 py-3 flex items-center justify-between" style={{background:bg}}>
        <div className="flex items-center gap-2">
          <span className="text-2xl">{esUrea?"🧪":"⛽"}</span>
          <div>
            <p className="font-black text-base" style={{color}}>{comb.tipo}</p>
            <p className="text-[10px] text-gray-500">por {comb.unidad}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-col items-end">
          {esUrea&&<span className="text-[9px] font-black bg-cyan-100 text-cyan-700 px-1.5 py-0.5 rounded-full">Solo Euro V/VI + Diésel</span>}
          {comb.precio_anterior&&<span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${sube?"bg-red-100 text-red-600":"bg-green-100 text-green-600"}`}>{sube?"▲":"▼"} {Math.abs(((comb.precio-comb.precio_anterior)/comb.precio_anterior)*100).toFixed(1)}%</span>}
        </div>
      </div>
      <div className="p-4 space-y-3">
        {esUrea&&<div className="rounded-xl bg-cyan-50 border border-cyan-200 px-3 py-2 text-[10px] text-cyan-700"><p className="font-black mb-0.5">AdBlue / DEF — Solución urea 32.5%</p><p>Aplica en motores <b>Euro V y Euro VI con Diésel</b>. Consumo: 3–5% del diésel. Reduce emisiones NOx.</p></div>}
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Precio vigente</p>
          {ed?(
            <div className="flex items-center gap-2">
              <span className="text-gray-400 font-bold">S/</span>
              <input type="number" step="0.01" min="0" className="flex-1 border-2 rounded-xl px-3 py-2 text-xl font-black font-mono outline-none" style={{borderColor:color}} value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")guardar();if(e.key==="Escape")setEd(false);}} autoFocus/>
              <button onClick={guardar} className="px-3 py-2 rounded-xl text-white font-bold text-sm" style={{background:color}}>✓</button>
            </div>
          ):(
            <button onClick={()=>{setVal(String(comb.precio));setEd(true);}} className="group w-full flex items-center gap-2 hover:bg-blue-50 rounded-xl p-2 transition-colors">
              <span className="text-3xl font-black font-mono" style={{color}}>S/ {fmtN(comb.precio)}</span>
              <span className="text-[11px] text-blue-400 opacity-0 group-hover:opacity-100 ml-auto font-bold">✏️ editar</span>
            </button>
          )}
        </div>
        {comb.precio_anterior&&<div className="flex justify-between text-xs"><span className="text-gray-400">Anterior</span><span className="font-mono text-gray-500">S/ {fmtN(comb.precio_anterior)}</span></div>}
        <div className={`rounded-xl px-3 py-2 flex items-center justify-between ${dias>7?"bg-red-50 border border-red-200":dias>3?"bg-amber-50 border border-amber-200":"bg-green-50 border border-green-200"}`}>
          <div>
            <p className="text-[10px] font-bold uppercase" style={{color:dias>7?"#dc2626":dias>3?"#d97706":"#16a34a"}}>{dias>7?"⚠ Desactualizado":dias>3?"⏰ Verificar":"✓ Reciente"}</p>
            <p className="text-[10px] text-gray-500">Actualizado hace {dias} día{dias!==1?"s":""}</p>
          </div>
          <span>{dias>7?"🔴":dias>3?"🟡":"🟢"}</span>
        </div>
        {comb.notas&&<p className="text-[10px] text-gray-400 italic">{comb.notas}</p>}
        <div className="flex justify-between text-[10px] text-gray-400"><span>Fuente: <b>{comb.fuente}</b></span><span>{comb.fecha_vigencia}</span></div>
      </div>
    </div>
  );
}

const FRM0={tipo_vehiculo:"",nombre:"",capacidad:"",icono:"🚌",grupo_vehiculo:"Buses",tipo_combustible_1:"Diésel",rendimiento_1:"",euronorm:"Euro III",n_neumaticos:"6",costo_neumatico:"1500",vida_neumatico_km:"65000",mantenimiento_km:"1.20",valor_compra:"",residual_pct:"0.15",vida_util_anios:"9",km_anio:"65000",seguro_anual:"",soat_anual:"",revision_semestral:"",permisos_anual:"",otros_fijos_mensual:"0",conductor_dia:""};

function FormNuevoVeh({combustibles,onGuardado,onCancelar}:{combustibles:Combustible[];onGuardado:()=>void;onCancelar:()=>void}) {
  const [form,setForm]=useState(FRM0);
  const [saving,setSaving]=useState(false);
  const f=(k:keyof typeof FRM0)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(p=>({...p,[k]:e.target.value}));
  const mostrarUrea=EURO_UREA.includes(form.euronorm)&&form.tipo_combustible_1==="Diésel";
  const combOpts=combustibles.filter(c=>c.tipo!=="UREA");

  async function guardar() {
    if(!form.tipo_vehiculo.trim()||!form.nombre.trim()||!form.capacidad||!form.rendimiento_1||!form.valor_compra){alert("Completa: ID, nombre, capacidad, rendimiento y valor de compra");return;}
    setSaving(true);
    const {error}=await supabase.from("parametros_costos").insert({
      tipo_vehiculo:form.tipo_vehiculo.trim().toUpperCase().replace(/\s+/g,"_"),
      nombre:form.nombre.trim(), capacidad:Number(form.capacidad),
      icono:form.icono, grupo_vehiculo:form.grupo_vehiculo,
      euronorm:form.euronorm,
      usa_urea:EURO_UREA.includes(form.euronorm)&&form.tipo_combustible_1==="Diésel",
      consumo_urea_pct:0.04, activo:true,
      tipo_combustible_1:form.tipo_combustible_1,
      rendimiento_1:Number(form.rendimiento_1), pct_uso_1:1.0,
      n_neumaticos:Number(form.n_neumaticos), costo_neumatico:Number(form.costo_neumatico),
      vida_neumatico_km:Number(form.vida_neumatico_km), mantenimiento_km:Number(form.mantenimiento_km),
      valor_compra:Number(form.valor_compra), residual_pct:Number(form.residual_pct),
      vida_util_anios:Number(form.vida_util_anios), km_anio:Number(form.km_anio),
      seguro_anual:Number(form.seguro_anual)||0, soat_anual:Number(form.soat_anual)||0,
      revision_semestral:Number(form.revision_semestral)||0, permisos_anual:Number(form.permisos_anual)||0,
      otros_fijos_mensual:Number(form.otros_fijos_mensual)||0, conductor_dia:Number(form.conductor_dia)||0,
    });
    if(error){alert(error.message);setSaving(false);return;}
    setSaving(false);onGuardado();
  }

  return(
    <div className="bg-white rounded-2xl border-2 border-[#0b315f] shadow-sm p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="font-black text-[#0b315f] text-base">➕ Agregar nuevo tipo de vehículo</h3>
        <button onClick={onCancelar} className="text-gray-400 hover:text-gray-600 font-bold text-xl">✕</button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">ID único *</label>
          <input className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono uppercase focus:outline-none focus:border-[#0b315f]" placeholder="BUS_60_GNV" value={form.tipo_vehiculo} onChange={e=>setForm(p=>({...p,tipo_vehiculo:e.target.value.toUpperCase().replace(/\s+/g,"_")}))}/>
          <p className="text-[9px] text-gray-300 mt-0.5">Sin espacios, usar guión bajo</p>
        </div>
        <div className="md:col-span-2">
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Nombre completo *</label>
          <input className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]" placeholder="Bus 60 pax GNV Euro V" value={form.nombre} onChange={f("nombre")}/>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Capacidad (pax) *</label>
          <input type="number" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]" placeholder="60" value={form.capacidad} onChange={f("capacidad")}/>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Grupo</label>
          <select className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]" value={form.grupo_vehiculo} onChange={f("grupo_vehiculo")}>
            {GRUPOS_VEH.map(g=><option key={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Ícono</label>
          <div className="flex gap-1.5 flex-wrap">
            {ICONOS_VEH.map(ic=><button key={ic} onClick={()=>setForm(p=>({...p,icono:ic}))} className={`text-xl p-1.5 rounded-lg border-2 transition-colors ${form.icono===ic?"border-[#0b315f] bg-[#eef3f8]":"border-gray-200"}`}>{ic}</button>)}
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Combustible *</label>
          <select className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]" value={form.tipo_combustible_1} onChange={f("tipo_combustible_1")} style={{color:COMB_COLOR[form.tipo_combustible_1]||"#333"}}>
            {combOpts.map(c=><option key={c.tipo}>{c.tipo}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Rendimiento * <span className="font-normal">(km/unidad)</span></label>
          <input type="number" step="0.5" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0b315f]" placeholder="7.5" value={form.rendimiento_1} onChange={f("rendimiento_1")}/>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Norma Euro</label>
          <select className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]" value={form.euronorm} onChange={f("euronorm")}>
            {EURO_NORMS.map(e=><option key={e}>{e}</option>)}
          </select>
        </div>
        {mostrarUrea&&(
          <div className="md:col-span-3 flex items-center">
            <div className="rounded-xl bg-cyan-50 border border-cyan-300 px-4 py-3 flex items-center gap-2 w-full">
              <span className="text-xl">🧪</span>
              <div>
                <p className="text-cyan-700 font-black text-sm">UREA activada automáticamente</p>
                <p className="text-cyan-600 text-xs">Motor {form.euronorm} + Diésel requiere AdBlue. Se calculará ~4% del consumo de diésel en el cotizador.</p>
              </div>
            </div>
          </div>
        )}
      </div>
      <div>
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2">Costos principales</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            {k:"valor_compra",       l:"Valor compra S/ *",   p:"650000"},
            {k:"conductor_dia",      l:"Conductor S/día *",   p:"260"},
            {k:"seguro_anual",       l:"Seguro anual S/",     p:"33000"},
            {k:"soat_anual",         l:"SOAT anual S/",       p:"2000"},
            {k:"revision_semestral", l:"Revisión técnica S/", p:"750"},
            {k:"permisos_anual",     l:"Permisos anuales S/", p:"9000"},
            {k:"mantenimiento_km",   l:"Mantenimiento S/km",  p:"2.00"},
            {k:"otros_fijos_mensual",l:"Otros fijos S/mes",   p:"0"},
          ].map(({k,l,p})=>(
            <div key={k}>
              <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">{l}</label>
              <input type="number" className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#0b315f]" placeholder={p} value={(form as any)[k]} onChange={e=>setForm(prev=>({...prev,[k]:e.target.value}))}/>
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-3">
        <button onClick={guardar} disabled={saving} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{background:"#0b315f"}}>
          {saving?"Guardando...":"✓ Guardar vehículo"}
        </button>
        <button onClick={onCancelar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
      </div>
    </div>
  );
}

export default function AjustesCostosPage() {
  const [combustibles,setCombustibles]=useState<Combustible[]>([]);
  const [params,setParams]           =useState<ParamCosto[]>([]);
  const [historial,setHistorial]     =useState<Historial[]>([]);
  const [loading,setLoading]         =useState(false);
  const [guardando,setGuardando]     =useState(false);
  const [tab,setTab]                 =useState<"combustible"|"vehiculos"|"historial">("combustible");
  const [grupoCampo,setGrupoCampo]   =useState(GRUPOS_CAMPOS[0]);
  const [userEmail,setUserEmail]     =useState("Sistema");
  const [motivo,setMotivo]           =useState("");
  const [alerta,setAlerta]           =useState("");
  const [mostrarForm,setMostrarForm] =useState(false);

  useEffect(()=>{supabase.auth.getUser().then(({data})=>{if(data?.user)setUserEmail(data.user.email||"Usuario");});},[]);

  const cargar=async()=>{
    setLoading(true);
    const [cR,pR,hR]=await Promise.all([
      supabase.from("precios_combustible").select("*").order("tipo"),
      supabase.from("parametros_costos").select("*").eq("activo",true).order("grupo_vehiculo").order("capacidad"),
      supabase.from("historial_costos").select("*").order("cambiado_en",{ascending:false}).limit(150),
    ]);
    setCombustibles(cR.data||[]);setParams(pR.data||[]);setHistorial(hR.data||[]);
    setLoading(false);
  };
  useEffect(()=>{cargar();},[]);

  const preciosMap=useMemo(()=>{const m:Record<string,number>={};combustibles.forEach(c=>{m[c.tipo]=c.precio;});return m;},[combustibles]);

  function mostrarAlerta(msg:string){setAlerta(msg);setTimeout(()=>setAlerta(""),4000);}

  const guardarComb=async(comb:Combustible,nuevoPrecio:number)=>{
    setGuardando(true);
    await supabase.from("precios_combustible").update({precio_anterior:comb.precio,precio:nuevoPrecio,fuente:"Manual",fecha_vigencia:new Date().toISOString().split("T")[0],actualizado_en:new Date().toISOString(),actualizado_por:userEmail,notas:motivo||`Manual por ${userEmail}`}).eq("id",comb.id);
    await supabase.from("historial_costos").insert({tabla_origen:"precios_combustible",tipo_combustible:comb.tipo,campo_modificado:"precio",valor_anterior:comb.precio,valor_nuevo:nuevoPrecio,motivo:motivo||"Actualización manual",cambiado_por:userEmail});
    mostrarAlerta(`✅ ${comb.tipo}: S/${fmtN(comb.precio)} → S/${fmtN(nuevoPrecio)}`);
    cargar();setGuardando(false);
  };

  const guardarParam=async(vehId:string,campo:string,vN:number,vA:number)=>{
    setGuardando(true);
    await supabase.from("parametros_costos").update({[campo]:vN,updated_by:userEmail}).eq("tipo_vehiculo",vehId);
    await supabase.from("historial_costos").insert({tabla_origen:"parametros_costos",tipo_vehiculo:vehId,campo_modificado:campo,valor_anterior:vA,valor_nuevo:vN,motivo:motivo||"Actualización manual",cambiado_por:userEmail});
    mostrarAlerta(`✅ ${vehId} · ${CAMPOS_EDIT.find(c=>c.key===campo)?.label||campo}: ${fmtN(vA)} → ${fmtN(vN)}`);
    cargar();setGuardando(false);
  };

  const cambiarComb=async(vehId:string,nuevoComb:string)=>{
    setGuardando(true);
    const veh=params.find(p=>p.tipo_vehiculo===vehId);
    const usaUrea=EURO_UREA.includes(veh?.euronorm||"")&&nuevoComb==="Diésel";
    await supabase.from("parametros_costos").update({tipo_combustible_1:nuevoComb,usa_urea:usaUrea,updated_by:userEmail}).eq("tipo_vehiculo",vehId);
    await supabase.from("historial_costos").insert({tabla_origen:"parametros_costos",tipo_vehiculo:vehId,campo_modificado:"tipo_combustible_1",valor_anterior:null,valor_nuevo:null,motivo:`Combustible → ${nuevoComb}${motivo?` | ${motivo}`:""}`,cambiado_por:userEmail});
    mostrarAlerta(`✅ ${vehId} → ${nuevoComb}${usaUrea?" + UREA activada":""}`);
    cargar();setGuardando(false);
  };

  const cambiarEuro=async(vehId:string,nuevaEuro:string)=>{
    setGuardando(true);
    const veh=params.find(p=>p.tipo_vehiculo===vehId);
    const usaUrea=EURO_UREA.includes(nuevaEuro)&&veh?.tipo_combustible_1==="Diésel";
    await supabase.from("parametros_costos").update({euronorm:nuevaEuro,usa_urea:usaUrea,updated_by:userEmail}).eq("tipo_vehiculo",vehId);
    mostrarAlerta(`✅ ${vehId} → ${nuevaEuro}${usaUrea?" | UREA activada":" | UREA desactivada"}`);
    cargar();setGuardando(false);
  };

  const desactivarVeh=async(vehId:string)=>{
    if(!confirm(`¿Desactivar ${vehId}? No aparecerá en Cotizador ni Cotizaciones.`))return;
    setGuardando(true);
    await supabase.from("parametros_costos").update({activo:false}).eq("tipo_vehiculo",vehId);
    mostrarAlerta(`✅ ${vehId} desactivado`);cargar();setGuardando(false);
  };

  const camposGrupo=CAMPOS_EDIT.filter(c=>c.grupo===grupoCampo);
  const gruposActivos=[...new Set(params.map(p=>p.grupo_vehiculo||"Otros"))];
  const combSinUrea=combustibles.filter(c=>c.tipo!=="UREA");

  return(
    <main className="p-6 space-y-5 max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Ajuste de Costos Operativos</h1>
          <p className="text-sm text-gray-400 mt-1">Parámetros de flota · Combustibles (incl. UREA Euro V/VI) · Los cambios aplican en tiempo real al Cotizador y Cotizaciones</p>
        </div>
        {guardando&&<div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700 font-bold"><div className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin"/>Guardando...</div>}
      </div>

      {alerta&&<div className="rounded-xl px-5 py-3 bg-green-50 border border-green-300 text-green-800 font-bold text-sm">{alerta}</div>}

      <div className="bg-white rounded-2xl border shadow-sm px-5 py-4 flex items-center gap-4">
        <div className="flex-shrink-0">
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Motivo del cambio</p>
          <p className="text-[10px] text-gray-300">Se registra en el historial de auditoría</p>
        </div>
        <input value={motivo} onChange={e=>setMotivo(e.target.value)} placeholder="Ej: Precio OSINERGMIN semana 20 · Ajuste inflación · Cambio de proveedor neumáticos..."
          className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#0b315f]"/>
        <span className="text-[11px] text-gray-400 flex-shrink-0">👤 <b>{userEmail}</b></span>
      </div>

      <div className="flex gap-1 border-b">
        {[{id:"combustible",label:"⛽ Combustible",count:combustibles.length},{id:"vehiculos",label:"🚌 Flota / Vehículos",count:params.length},{id:"historial",label:"📋 Historial",count:historial.length}].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id as any)}
            className="flex items-center gap-2 px-5 py-3 text-sm font-bold border-b-2 -mb-px transition-all"
            style={{borderColor:tab===t.id?"#0b315f":"transparent",color:tab===t.id?"#0b315f":"#9ca3af"}}>
            {t.label}
            <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full text-white" style={{background:tab===t.id?"#0b315f":"#d1d5db"}}>{t.count}</span>
          </button>
        ))}
      </div>

      {tab==="combustible"&&(
        <div className="space-y-4">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3">
            <span className="text-2xl">⛽</span>
            <div className="flex-1">
              <p className="font-black text-amber-800 text-sm">Verificar precios en FacilitO — OSINERGMIN</p>
              <p className="text-amber-700 text-xs mt-1">Precios actuales registrados: Diésel B5 S/24.00 · Gasolina 90 S/22.00 · GLP S/8.50 · GNV S/1.90 · UREA S/2.50</p>
              <a href="https://www.facilito.gob.pe/facilito/pages/facilito/menuPrecios.jsp" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 mt-2 px-4 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-black hover:bg-amber-700">🌐 Abrir FacilitO OSINERGMIN →</a>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
            {combustibles.map(comb=><CombCard key={comb.id} comb={comb} onGuardar={n=>guardarComb(comb,n)}/>)}
          </div>
          <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-black text-[#0b315f] text-sm">Impacto en costo S/km — precios actuales</h2>
              <p className="text-xs text-gray-400 mt-0.5">UREA incluida para vehículos Euro V/VI con Diésel</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>{["Vehículo","Grupo","Combustible","Euro","UREA","Rend.","S/km comb.","S/km total","S/día (100km)"].map(h=><th key={h} className="px-3 py-3 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {params.map(p=>{
                    const pc=preciosMap[p.tipo_combustible_1]||0;
                    const combKm=pc/p.rendimiento_1;
                    const totalKm=calcCostoKm(p,preciosMap);
                    const ureaKm=p.usa_urea&&p.tipo_combustible_1==="Diésel"?(1/p.rendimiento_1)*3.785*(p.consumo_urea_pct||0.04)*(preciosMap["UREA"]||0):0;
                    return(
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2.5 font-bold text-gray-800 text-xs">{p.icono||"🚌"} {p.nombre}</td>
                        <td className="px-3 py-2.5 text-xs text-gray-500">{p.grupo_vehiculo}</td>
                        <td className="px-3 py-2.5"><span className="text-[10px] font-black px-2 py-0.5 rounded-full text-white" style={{background:COMB_COLOR[p.tipo_combustible_1]||"#666"}}>{p.tipo_combustible_1}</span></td>
                        <td className="px-3 py-2.5 text-xs font-bold" style={{color:EURO_UREA.includes(p.euronorm||"")?"#0891b2":"#9ca3af"}}>{p.euronorm||"—"}</td>
                        <td className="px-3 py-2.5 text-center">{p.usa_urea?<div><span className="text-sm">🧪</span><p className="text-[9px] text-cyan-600 font-bold">+S/{fmtN(ureaKm,4)}</p></div>:<span className="text-gray-300 text-xs">—</span>}</td>
                        <td className="px-3 py-2.5 text-xs font-mono text-gray-600">{p.rendimiento_1} km/{p.tipo_combustible_1==="GNV"?"m³":"gal"}</td>
                        <td className="px-3 py-2.5 font-mono font-bold text-orange-600 text-xs">S/ {fmtN(combKm,4)}</td>
                        <td className="px-3 py-2.5 font-mono font-black text-[#0b315f] text-xs">S/ {fmtN(totalKm,4)}</td>
                        <td className="px-3 py-2.5 font-mono font-bold text-gray-700 text-xs">{fmtS(totalKm*100+p.conductor_dia)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab==="vehiculos"&&(
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">{params.length} vehículos activos · Clic en celda para editar · El dropdown cambia combustible y activa/desactiva UREA automáticamente</p>
            <button onClick={()=>setMostrarForm(v=>!v)} className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{background:mostrarForm?"#6b7280":"#0b315f"}}>
              {mostrarForm?"✕ Cancelar":"➕ Agregar vehículo"}
            </button>
          </div>
          {mostrarForm&&<FormNuevoVeh combustibles={combustibles} onGuardado={()=>{cargar();setMostrarForm(false);mostrarAlerta("✅ Vehículo agregado — ya disponible en Cotizador y Cotizaciones");}} onCancelar={()=>setMostrarForm(false)}/>}
          <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
            <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider mb-3">Categoría de parámetros a editar</p>
            <div className="flex flex-wrap gap-2">
              {GRUPOS_CAMPOS.map(g=>(
                <button key={g} onClick={()=>setGrupoCampo(g)} className="px-4 py-2 rounded-xl border-2 text-sm font-bold transition-all"
                  style={{background:grupoCampo===g?"#eef3f8":"white",borderColor:grupoCampo===g?"#0b315f":"#e5e7eb",color:grupoCampo===g?"#0b315f":"#9ca3af"}}>
                  {{"Combustible":"⛽ ","Neumáticos":"🔵 ","Mantenimiento":"🔧 ","Depreciación":"📉 ","Seguros y fijos":"🛡️ ","Mano de obra":"👷 "}[g]}{g}
                </button>
              ))}
            </div>
          </div>
          {gruposActivos.map(grupo=>{
            const vehs=params.filter(p=>(p.grupo_vehiculo||"Otros")===grupo);
            if(!vehs.length)return null;
            const gc=GRUPO_CFG[grupo]||GRUPO_CFG.Otros;
            return(
              <div key={grupo} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                <div className="px-5 py-3 flex items-center gap-2 border-b" style={{background:gc.bg}}>
                  <span className="font-black text-sm" style={{color:gc.color}}>{grupo}</span>
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full text-white" style={{background:gc.color}}>{vehs.length} vehículos</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left text-[10px] font-black text-gray-400 uppercase sticky left-0 bg-gray-50 z-10 min-w-[190px]">Vehículo</th>
                        <th className="px-3 py-3 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">Combustible</th>
                        <th className="px-3 py-3 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">Norma Euro</th>
                        <th className="px-3 py-3 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">UREA</th>
                        {camposGrupo.map(c=><th key={c.key} className="px-3 py-3 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap"><div>{c.label}</div><div className="text-[9px] font-normal text-gray-300 normal-case">{c.unidad}</div></th>)}
                        <th className="px-3 py-3 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">S/km</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {vehs.map(p=>{
                        const costoKm=calcCostoKm(p,preciosMap);
                        return(
                          <tr key={p.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 sticky left-0 bg-white z-10 border-r border-gray-100">
                              <div className="flex items-center gap-1.5">
                                <span className="text-lg">{p.icono||"🚌"}</span>
                                <div>
                                  <div className="font-bold text-gray-800 text-xs">{p.nombre}</div>
                                  <div className="text-[10px] text-gray-400">{p.capacidad} pax</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <select value={p.tipo_combustible_1} onChange={e=>cambiarComb(p.tipo_vehiculo,e.target.value)}
                                className="border border-gray-200 rounded-lg px-2 py-1 text-xs font-bold cursor-pointer outline-none focus:border-[#0b315f]"
                                style={{color:COMB_COLOR[p.tipo_combustible_1]||"#666"}}>
                                {combSinUrea.map(c=><option key={c.tipo}>{c.tipo}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-2.5">
                              <select value={p.euronorm||"Euro III"} onChange={e=>cambiarEuro(p.tipo_vehiculo,e.target.value)}
                                className={`border rounded-lg px-2 py-1 text-xs font-bold cursor-pointer outline-none ${EURO_UREA.includes(p.euronorm||"")?"border-cyan-300 text-cyan-700 bg-cyan-50":"border-gray-200 text-gray-600"}`}>
                                {EURO_NORMS.map(e=><option key={e}>{e}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              {p.usa_urea?<span className="text-[10px] font-black text-cyan-700 bg-cyan-50 border border-cyan-200 px-2 py-0.5 rounded-full">🧪 Activa</span>:<span className="text-[10px] text-gray-300">—</span>}
                            </td>
                            {camposGrupo.map(c=><td key={c.key} className="px-3 py-2"><CeldaEditable valor={p[c.key] as number} campo={c.key} vehId={p.tipo_vehiculo} unidad={c.unidad} step={c.step} onGuardado={(campo,vN,vA)=>guardarParam(p.tipo_vehiculo,campo,vN,vA)}/></td>)}
                            <td className="px-3 py-3"><span className="font-black font-mono text-[#0b315f] text-sm">S/ {fmtN(costoKm,4)}</span></td>
                            <td className="px-3 py-2.5"><button onClick={()=>desactivarVeh(p.tipo_vehiculo)} className="text-[10px] text-red-400 hover:text-red-600 border border-red-100 hover:bg-red-50 px-2 py-1 rounded-lg font-bold">Desactivar</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab==="historial"&&(
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <h2 className="font-black text-[#0b315f] text-sm">Historial de cambios</h2>
            <span className="text-xs text-gray-400">{historial.length} registros</span>
          </div>
          {historial.length===0?(
            <div className="p-16 text-center text-gray-400"><p className="text-3xl mb-2">📋</p><p>No hay cambios registrados</p></div>
          ):(
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>{["Fecha","Tipo","Registro","Campo","Valor ant.","Valor nuevo","Variación","Motivo","Usuario"].map(h=><th key={h} className="px-4 py-3 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {historial.map(h=>{
                    const sube=(h.valor_nuevo||0)>(h.valor_anterior||0);
                    return(
                      <tr key={h.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtDt(h.cambiado_en)}</td>
                        <td className="px-4 py-2.5"><span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${h.tabla_origen==="precios_combustible"?"bg-orange-100 text-orange-700":"bg-blue-100 text-blue-700"}`}>{h.tabla_origen==="precios_combustible"?"⛽ Combustible":"🚌 Vehículo"}</span></td>
                        <td className="px-4 py-2.5 font-bold text-gray-700 text-xs">{h.tipo_vehiculo||h.tipo_combustible||"—"}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-600">{CAMPOS_EDIT.find(c=>c.key===h.campo_modificado)?.label||h.campo_modificado}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{h.valor_anterior!==null?fmtN(h.valor_anterior,2):"—"}</td>
                        <td className="px-4 py-2.5 font-mono font-black text-xs text-[#0b315f]">{h.valor_nuevo!==null?fmtN(h.valor_nuevo,2):"—"}</td>
                        <td className="px-4 py-2.5">{h.valor_anterior&&h.valor_nuevo?<span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${sube?"bg-red-100 text-red-600":"bg-green-100 text-green-600"}`}>{sube?"▲":"▼"} {Math.abs(((h.valor_nuevo-h.valor_anterior)/h.valor_anterior)*100).toFixed(1)}%</span>:"—"}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 max-w-[180px]"><div className="truncate">{h.motivo||"—"}</div></td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{h.cambiado_por||"—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
