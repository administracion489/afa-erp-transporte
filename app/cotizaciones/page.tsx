"use client";
import React, { useEffect, useState, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";

type FechaMultidia={dia:number;fecha:string;hora_ida:string;hora_fin:string;tipo_noche:"pernocte"|"cochera"|"";destino_nombre:string;destino_lat:string;destino_lng:string;};
type ParamCosto={tipo_vehiculo:string;nombre:string;capacidad:number;activo:boolean;icono:string|null;grupo_vehiculo:string|null;euronorm:string|null;usa_urea:boolean;consumo_urea_pct:number|null;tipo_combustible_1:string;rendimiento_1:number;pct_uso_1:number;tipo_combustible_2:string|null;rendimiento_2:number|null;pct_uso_2:number|null;n_neumaticos:number;costo_neumatico:number;vida_neumatico_km:number;mantenimiento_km:number;valor_compra:number;residual_pct:number;vida_util_anios:number;km_anio:number;seguro_anual:number;soat_anual:number;revision_semestral:number;permisos_anual:number;otros_fijos_mensual:number;conductor_dia:number;};
type EstadoCot="borrador"|"pendiente"|"enviado"|"aprobado"|"rechazado";
type ModoServ="eventual"|"fijo";
type ItemCot={descripcion:string;dias:number;cantidad:number;precio_unit:number;descuento_pct:number;vehiculo_flota_id?:number|null;vehiculo_tercero_id?:number|null;};
type ConsidCot={incluye:string[];no_incluye:string[];generales:string[];};
type Cliente={id:number;nombre:string;empresa?:string;tipo?:string;ruc?:string;dni?:string;telefono?:string;email?:string;direccion?:string;estado?:string;operativo_nombre?:string;};
type Cotizacion={id:number;cliente_id:number|null;origen:string;destino:string;km:number;precio_cliente:number;costo_estimado:number;margen_estimado:number;estado:EstadoCot;numero_cotizacion:string|null;atencion:string|null;asunto:string|null;punto_retorno:string|null;fecha_servicio:string|null;fecha_retorno:string|null;hora_ida:string|null;hora_retorno:string|null;descuento_pct:number;items_json:ItemCot[]|null;numero_aprobacion:string|null;tipo_aprobacion:string|null;medio_envio:string|null;tipo_vehiculo:string|null;tipo_servicio:string|null;equipamiento:string|null;vehiculo_flota_id:number|null;vehiculo_tercero_id:number|null;consideraciones_json:ConsidCot|null;paradas_json:ParadaTP[]|null;paradas_retorno_json:ParadaTP[]|null;created_at:string;modo_servicio:ModoServ|null;dias_servicio:number|null;horas_servicio:number|null;pernocte_costo:number|null;precio_dia:number|null;precio_mes_estimado:number|null;precio_tarifario:number|null;precio_cotizador:number|null;costo_cotizador:number|null;margen_cotizador:number|null;vehiculo_cotizador:string|null;precio_sugerido:number|null;modo_precio:string|null;enviado_automatico:boolean;descuento_solicitado:boolean;descuento_pct_solicitado:number|null;descuento_autorizado:boolean;hora_solicitud_descuento:string|null;plantilla_pdf:string|null;incluye_igv:boolean|null;itinerario_texto:string|null;fechas_multidia_json:FechaMultidia[]|null;};
type EmpresaPerfilPDF={nombre:string|null;razon_social:string|null;ruc:string|null;logo_url:string|null;telefono:string|null;email:string|null;direccion:string|null;color_primario:string|null;web:string|null;};
type CotPlantillaConfig={id:string;color_primario:string;color_secundario:string;color_acento:string;titulo_documento:string;subtitulo:string|null;mensaje_cierre:string|null;mostrar_logo:boolean;mostrar_fotos_vehiculo:boolean;mostrar_itinerario:boolean;mostrar_precio_pax:boolean;mostrar_cuentas_bancarias:boolean;mostrar_firma:boolean;condiciones_incluye:string[]|null;condiciones_no_incluye:string[]|null;condiciones_generales:string[]|null;banco_1_nombre:string|null;banco_1_cuenta:string|null;banco_1_cci:string|null;banco_2_nombre:string|null;banco_2_cuenta:string|null;banco_2_cci:string|null;banco_3_nombre:string|null;banco_3_cuenta:string|null;banco_3_cci:string|null;usar_bancos_propios:boolean;idioma:string;};
type ParadaTP={id:string;tipo:"inicio"|"intermedia"|"destino";nombre:string;direccion:string;lat:string;lng:string;hora:string;};
type Tarifa={id:number;origen:string;destino:string;tipo_vehiculo:string;equipamiento:string;tipo_servicio:string;modo:string;precio:number;moneda:string;confidencial:boolean;incluye_guia:boolean;incluye_peajes:boolean;incluye_alimentacion:boolean;notas:string|null;};
type VehiculoFlota={id:number;placa:string;categoria:string|null;marca:string|null;modelo:string|null;anio:number|null;capacidad_pasajeros:number|null;equipamiento:string|null;foto_externa_url:string|null;foto_interna_url:string|null;descripcion_unidad:string|null;tipo_vehiculo_costeo:string|null;};
type VehiculoTerceroFlota={id:number;empresa_id:number;placa:string;categoria:string|null;marca:string|null;modelo:string|null;capacidad:number|null;estado:string;empresa_nombre?:string;foto_externa_url:string|null;foto_interna_url:string|null;descripcion_unidad:string|null;tipo_vehiculo_costeo:string|null;};

const IGV=0.18,OVERHEAD=0.10,RESERVA=0.05;
const DEFAULT_CONSID:ConsidCot={incluye:["Traslado de origen a destino","Conductor profesional certificado","Combustible durante todo el recorrido","GPS en tiempo real","Seguro de viaje SOAT vigente"],no_incluye:["Alimentación y bebidas","Guía turístico","Entradas a atractivos turísticos"],generales:["Precios según fechas y horarios coordinados.","Tolerancia máxima de espera: 30 minutos.","No se permite consumo de alcohol ni tabaco a bordo.","Cambios en ruta u horario pueden generar costos adicionales.","Servicio eventual: adelanto del 50% para confirmar.","Recomendamos reservar con 7 días de anticipación mínimo."]};
const SERVS_EVENTUAL=[{id:"solo_ida",label:"➡️ Solo Ida",cat:"Traslados"},{id:"ida_retorno",label:"⇄ Ida y Retorno",cat:"Traslados"},{id:"ida_retorno_paradas",label:"📍 Con Paradas",cat:"Disposición"},{id:"full_day",label:"⭐ Full Day",cat:"Turismo"},{id:"multi_dia",label:"🏕️ Multi-día",cat:"Turismo"}];
const SERVS_FIJO=[{id:"fijo_solo_ida",label:"→ Solo Ida",cat:"Ruta Simple"},{id:"transporte_personal",label:"⇄ Ida y Retorno",cat:"Ruta Simple"},{id:"fijo_multiparada",label:"📍 Con Paraderos",cat:"Ruta Logística"},{id:"fijo_reten",label:"🏭 Retén / Planta",cat:"Retén"}];
const ESTADO_CFG:Record<EstadoCot,{label:string;bg:string;color:string}>={borrador:{label:"Borrador",bg:"#f3f4f6",color:"#6b7280"},pendiente:{label:"Pendiente",bg:"#fef9c3",color:"#854d0e"},enviado:{label:"Enviado",bg:"#e0f2fe",color:"#0369a1"},aprobado:{label:"Aprobado",bg:"#dcfce7",color:"#166534"},rechazado:{label:"Rechazado",bg:"#fee2e2",color:"#991b1b"}};
const TRANSICIONES:Record<EstadoCot,EstadoCot[]>={borrador:["pendiente"],pendiente:["enviado"],enviado:["aprobado","rechazado"],aprobado:[],rechazado:["pendiente"]};
const TIPOS_APROBACION=["Operación bancaria","Orden de compra","Orden de servicio","Correo de confirmación","Contrato firmado"];
const ITEM_VACIO:ItemCot={descripcion:"",dias:1,cantidad:1,precio_unit:0,descuento_pct:0};
const FORM0={cliente_id:"",origen:"",destino:"",km:"",costo_estimado:"",estado:"pendiente" as EstadoCot,numero_cotizacion:"",atencion:"",asunto:"",punto_retorno:"",fecha_servicio:"",fecha_retorno:"",hora_ida:"",hora_retorno:"",descuento_pct:"0",tipo_vehiculo:"",equipamiento:"full_equipo",vehiculo_flota_id:"",vehiculo_tercero_id:"",modo_servicio:"eventual" as ModoServ,tipo_servicio:"solo_ida",dias_servicio:"1",horas_servicio:"8",pernocte_costo:"0",precio_dia:"",incluye_igv:true,itinerario_texto:""};

const fmtS=(n:number)=>`S/ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtF=(f:string|null)=>f?new Date(f+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}):"—";
const calcItems=(items:ItemCot[],conIGV=true)=>{const s=items.reduce((t,it)=>t+it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100),0);return{subtotal:s,igv:conIGV?s*0.18:0,total:conIGV?s*1.18:s};};
const norm=(s:string)=>s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const iCls=(e="")=>`w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${e}`;
const driveImg=(url:string)=>{if(!url)return url;const m=url.match(/\/d\/([a-zA-Z0-9_-]{20,})/)||url.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);return m?`https://drive.google.com/thumbnail?id=${m[1]}&sz=w800`:url;};
function extraerNombreApellido(nombre:string):string{const p=nombre.toUpperCase().trim().split(/\s+/).filter(Boolean);if(p.length===0)return nombre.toUpperCase();if(p.length<=2)return p.join(" ");if(p.length===3)return p[0]+" "+p[1];return p[0]+" "+p[2];}
const enHorario=()=>{const l=new Date(new Date().toLocaleString("en-US",{timeZone:"America/Lima"}));return l.getDay()>=1&&l.getDay()<=5&&l.getHours()>=8&&l.getHours()<18;};
const GRUPO_COLOR:{[k:string]:{color:string;bg:string}}={Ligeros:{color:"#6366f1",bg:"#eef2ff"},Vans:{color:"#0891b2",bg:"#ecfeff"},Buses:{color:"#0b315f",bg:"#eef3f8"},Otros:{color:"#6b7280",bg:"#f3f4f6"}};

function Campo({label,span,req,hint,children}:{label:string;span?:number;req?:boolean;hint?:string;children:React.ReactNode}){
  return(<div className={span===2?"md:col-span-2":span===3?"md:col-span-3":""}><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}{req&&<span className="text-red-400 ml-0.5">*</span>}</label>{children}{hint&&<p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}</div>);
}

function calcCostoVeh(p:ParamCosto,pr:Record<string,number>,km:number,dias:number,peajes:number,pernocte:number,viaticos:number){
  const pc1=pr[p.tipo_combustible_1]||0;
  const combKm=(pc1/p.rendimiento_1)*p.pct_uso_1+(p.tipo_combustible_2&&p.rendimiento_2&&p.pct_uso_2?((pr[p.tipo_combustible_2]||0)/p.rendimiento_2)*p.pct_uso_2:0);
  const ureaRate=p.usa_urea&&p.tipo_combustible_1==="Diésel"?(1/p.rendimiento_1)*3.785*(p.consumo_urea_pct||0.04)*(pr["UREA"]||0):0;
  const sub=((combKm+ureaRate)*km)+((p.n_neumaticos*p.costo_neumatico)/p.vida_neumatico_km)*km+p.mantenimiento_km*km+((p.valor_compra*(1-p.residual_pct))/(p.vida_util_anios*p.km_anio))*km+((p.seguro_anual+p.soat_anual+p.revision_semestral*2+p.permisos_anual+p.otros_fijos_mensual*12)/p.km_anio)*km;
  const total=(sub+sub*RESERVA)+p.conductor_dia*dias+peajes;
  const base=total+total*OVERHEAD+pernocte+viaticos;
  const pF=(m:number)=>base/(1-m);const fF=(m:number)=>pF(m)*(1+IGV);
  return{baseCosto:base,totalMin15:fF(0.15),totalEst20:fF(0.20),totalAlto25:fF(0.25),sinIGV15:pF(0.15),sinIGV20:pF(0.20),sinIGV25:pF(0.25),precioPax20:fF(0.20)/(p.capacidad||1),diaEstIGV:fF(0.20),diaMinIGV:fF(0.15),mesEstIGV:fF(0.20)*26};
}

function SugerenciaEnVivo({origen,destino,tipoVehId,tipoServ,equip,km,dias,peajes,pernocte,viaticos,modoServ,tarifas,paramsDB,preciosDB,onAplicar}:{origen:string;destino:string;tipoVehId:string;tipoServ:string;equip:string;km:number;dias:number;peajes:number;pernocte:number;viaticos:number;modoServ:ModoServ;tarifas:Tarifa[];paramsDB:ParamCosto[];preciosDB:Record<string,number>;onAplicar:(sinIGV:number,fuente:string,costo?:number)=>void;}){
  const veh=paramsDB.find(p=>p.tipo_vehiculo===tipoVehId);
  const costo=useMemo(()=>veh?calcCostoVeh(veh,preciosDB,km>0?km:1,dias,peajes,pernocte,viaticos):null,[veh,preciosDB,km,dias,peajes,pernocte,viaticos]);
  const tarifaExacta=useMemo(()=>tarifas.find(t=>norm(t.origen)===norm(origen)&&norm(t.destino)===norm(destino)&&t.tipo_vehiculo===tipoVehId&&t.equipamiento===equip&&t.tipo_servicio===tipoServ&&(t.modo||"eventual")===modoServ),[tarifas,origen,destino,tipoVehId,equip,tipoServ,modoServ]);
  if(!veh&&!tarifaExacta)return null;
  const enOf=enHorario();const esFijo=modoServ==="fijo";
  // Valores SIN IGV para display (precio_unit se almacena sin IGV)
  const dispMin  = esFijo ? (costo?.diaMinIGV||0)/1.18 : (costo?.sinIGV15||0);
  const dispEst  = esFijo ? (costo?.diaEstIGV||0)/1.18 : (costo?.sinIGV20||0);
  const dispTarif= tarifaExacta?.precio||0; // tarifario siempre guarda precio sin IGV
  const dispSug  = Math.max(dispEst, dispTarif);
  return(
    <div className="rounded-2xl overflow-hidden border-2 border-[#0b315f]" style={{background:"#0b315f"}}>
      <div className="px-5 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-white/15 flex items-center justify-center">⚡</div>
          <div>
            <p className="font-black text-white text-sm">Calculador en tiempo real</p>
            <p className="text-white/50 text-[10px]">{veh?.icono||"🚌"} {veh?.nombre} · {km||"?"} km{veh?.usa_urea?" · 🧪 UREA":""}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-lg text-[9px] font-black bg-white/10 text-white/60 uppercase tracking-wider">Precios sin IGV</span>
          <div className={`px-3 py-1 rounded-xl text-[11px] font-bold ${enOf?"bg-green-500/20 text-green-300":"bg-amber-500/20 text-amber-300"}`}>{enOf?"🟢 Horario oficina":"🟡 Fuera horario"}</div>
        </div>
      </div>
      <div className="px-5 pb-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {/* Mínimo 15% */}
          <div className="rounded-xl bg-red-500/10 border border-red-400/20 p-3">
            <p className="text-[9px] font-black text-red-300 uppercase mb-1">⛔ Mínimo 15%</p>
            {km>0&&costo?(<>
              <p className="font-black text-lg text-white font-mono">{fmtS(dispMin)}</p>
              <p className="text-[9px] text-red-300/60 mb-1">+IGV → {fmtS(dispMin*1.18)}</p>
              <button onClick={()=>onAplicar(dispMin,"cotizador_min",costo.baseCosto)} className="w-full py-1 rounded-lg text-[10px] font-black text-white bg-red-500/30 hover:bg-red-500/50">Usar mínimo</button>
            </>):<p className="text-white/25 text-xs mt-1">Ingresa km</p>}
          </div>
          {/* Estándar 20% */}
          <div className="rounded-xl bg-blue-500/15 border-2 border-blue-400/40 p-3 relative">
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[8px] font-black px-2 py-0.5 rounded-full whitespace-nowrap">RECOMENDADO</div>
            <p className="text-[9px] font-black text-blue-300 uppercase mb-1">🔧 Estándar 20%</p>
            {km>0&&costo?(<>
              <p className="font-black text-lg text-white font-mono">{fmtS(dispEst)}</p>
              <p className="text-[9px] text-blue-300/70">{esFijo?`~${fmtS(dispEst*26)}/mes`:`${fmtS(costo.precioPax20/1.18)}/pax`}</p>
              <button onClick={()=>onAplicar(dispEst,"cotizador",costo.baseCosto)} className="mt-2 w-full py-1 rounded-lg text-[10px] font-black text-white bg-blue-500 hover:bg-blue-400">✓ Usar estándar</button>
            </>):<p className="text-white/25 text-xs mt-1">Ingresa km</p>}
          </div>
          {/* Tarifario */}
          <div className={`rounded-xl p-3 border ${tarifaExacta?"bg-green-500/15 border-green-400/40":"bg-white/8 border-white/15"}`}>
            {tarifaExacta?(<>
              <p className="text-[9px] font-black text-green-300 uppercase mb-1">📋 Tarifario</p>
              <p className="font-black text-lg text-white font-mono">{fmtS(dispTarif)}</p>
              <p className="text-[9px] text-green-300/60 mb-1">+IGV → {fmtS(dispTarif*1.18)}</p>
              <button onClick={()=>onAplicar(dispTarif,"tarifario")} className="w-full py-1 rounded-lg text-[10px] font-black text-white bg-green-600 hover:bg-green-500">✓ Usar tarifario</button>
            </>):(<>
              <p className="text-[9px] font-black text-white/40 uppercase mb-1">📋 Tarifario</p>
              <p className="text-white/25 text-xs">{origen&&destino?`Sin tarifa: ${origen}→${destino}`:"Ingresa origen y destino"}</p>
            </>)}
          </div>
        </div>
        {/* Precio sugerido */}
        {dispSug>0&&(<div className="rounded-xl bg-white/10 border border-white/20 px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-white/50 text-[10px] font-bold uppercase">⭐ Precio sugerido <span className="text-white/30 normal-case font-normal">(sin IGV)</span></p>
            <p className="text-white font-black text-xl font-mono">{fmtS(dispSug)}</p>
            <p className="text-white/40 text-[10px]">Con IGV → {fmtS(dispSug*1.18)}{esFijo&&costo?`  ·  ~${fmtS(dispSug*26)}/mes s/IGV`:""}</p>
          </div>
          <button onClick={()=>onAplicar(dispSug,"sugerido",costo?.baseCosto)} className="px-4 py-2.5 rounded-xl font-black text-sm bg-white text-[#0b315f] hover:bg-gray-100 flex-shrink-0">→ Aplicar</button>
        </div>)}
      </div>
    </div>
  );
}

function PanelDecision({c,onAct}:{c:Cotizacion;onAct:()=>void}){
  const [guardando,setGuardando]=useState(false);const [descPct,setDescPct]=useState(c.descuento_pct_solicitado?.toString()||"");
  const enOf=enHorario();if(!c.precio_cotizador&&!c.precio_tarifario)return null;
  const esFijo=c.modo_servicio==="fijo";const tarifIGV=c.precio_tarifario?c.precio_tarifario*1.18:null;const precSug=Math.max(c.precio_cotizador||0,tarifIGV||0)||Number(c.precio_cliente);const precDesc=c.descuento_pct_solicitado?precSug*(1-c.descuento_pct_solicitado/100):null;const fuente=c.precio_cotizador&&tarifIGV?(c.precio_cotizador>=tarifIGV?"Cotizador":"Tarifario"):c.precio_cotizador?"Cotizador":"Tarifario";
  async function getCosto(){const{data}=await supabase.from("cotizaciones").select("costo_estimado").eq("id",c.id).single();return Number(data?.costo_estimado||0);}
  async function aplicar(precio:number,modo:string){setGuardando(true);const costo=await getCosto();await supabase.from("cotizaciones").update({precio_cliente:precio,margen_estimado:precio-costo,precio_sugerido:precSug,modo_precio:modo,enviado_automatico:!enOf}).eq("id",c.id);setGuardando(false);onAct();}
  async function solDesc(){const pct=parseFloat(descPct);if(!pct||pct<=0||pct>=100)return;setGuardando(true);await supabase.from("cotizaciones").update({descuento_solicitado:true,descuento_pct_solicitado:pct,descuento_autorizado:false,hora_solicitud_descuento:new Date().toISOString()}).eq("id",c.id);setGuardando(false);onAct();}
  async function autDesc(){if(!precDesc)return;setGuardando(true);const costo=await getCosto();await supabase.from("cotizaciones").update({precio_cliente:precDesc,margen_estimado:precDesc-costo,descuento_autorizado:true,modo_precio:"descuento_autorizado"}).eq("id",c.id);setGuardando(false);onAct();}
  async function rechDesc(){setGuardando(true);await supabase.from("cotizaciones").update({descuento_autorizado:false,descuento_solicitado:false}).eq("id",c.id);setGuardando(false);onAct();}
  return(<div className="mt-2 rounded-xl border overflow-hidden" style={{borderColor:"#0b315f22"}}><div className="px-3 py-2 flex items-center gap-2 flex-wrap" style={{background:"#eef3f8"}}><span className="text-[11px] font-black text-[#0b315f]">💡 Precios{esFijo?" · FIJO":""}</span>{c.precio_cotizador&&<span className="text-[10px] bg-blue-100 text-blue-700 font-bold px-1.5 py-0.5 rounded-full">🔧 {fmtS(c.precio_cotizador)}{esFijo?"/día":""}</span>}{tarifIGV&&<span className="text-[10px] bg-green-100 text-green-700 font-bold px-1.5 py-0.5 rounded-full">📋 {fmtS(tarifIGV)}{esFijo?"/día":""}</span>}<span className="text-[10px] bg-[#0b315f] text-white font-bold px-1.5 py-0.5 rounded-full">⭐ {fmtS(precSug)} ({fuente})</span>{c.descuento_solicitado&&!c.descuento_autorizado&&<span className="text-[10px] bg-orange-100 text-orange-700 font-bold px-1.5 py-0.5 rounded-full animate-pulse">🙋 {c.descuento_pct_solicitado}% pendiente</span>}{esFijo&&c.precio_mes_estimado&&<span className="text-[10px] bg-green-50 text-green-700 font-bold px-1.5 py-0.5 rounded-full">📅 ~{fmtS(c.precio_mes_estimado)}/mes</span>}</div><div className="p-3 bg-white space-y-3">{!enOf&&<div className="rounded-xl px-3 py-2 border border-amber-200 bg-amber-50 text-xs text-amber-800 font-semibold">⏰ Fuera de horario L-V 8-18h — precio máximo sugerido automáticamente</div>}{c.descuento_solicitado&&!c.descuento_autorizado&&(<div className="rounded-xl border-2 border-orange-300 bg-orange-50 p-3"><p className="font-black text-orange-800 text-sm mb-2">🙋 Descuento {c.descuento_pct_solicitado}% → {precDesc?fmtS(precDesc):"—"}</p>{enOf?<div className="flex gap-2"><button onClick={autDesc} disabled={guardando} className="flex-1 py-1.5 rounded-xl font-black text-xs text-white bg-green-600 disabled:opacity-50">✅ Autorizar</button><button onClick={rechDesc} disabled={guardando} className="px-3 py-1.5 rounded-xl font-bold text-xs border border-red-200 text-red-600 disabled:opacity-50">✕</button></div>:<p className="text-orange-600 text-xs font-bold text-center bg-orange-100 rounded-lg py-1.5">⏰ Se responderá en horario de oficina</p>}</div>)}<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{[{label:"🔧 Cotizador",val:c.precio_cotizador,color:"blue",modo:"cotizador"},{label:"📋 Tarifario",val:tarifIGV,color:"green",modo:"tarifario"},{label:"⭐ Sugerido",val:precSug,color:"navy",modo:"sugerido"}].map(item=>(<div key={item.label} className={`rounded-xl border-2 p-2.5 ${item.color==="blue"?"border-blue-200 bg-blue-50":item.color==="green"?"border-green-200 bg-green-50":"border-[#0b315f] bg-[#eef3f8]"}`}><p className={`text-[9px] font-bold uppercase mb-1 ${item.color==="blue"?"text-blue-600":item.color==="green"?"text-green-600":"text-[#0b315f]"}`}>{item.label}</p><p className={`font-black text-sm font-mono ${item.color==="blue"?"text-blue-700":item.color==="green"?"text-green-700":"text-[#0b315f]"}`}>{item.val?fmtS(item.val):"—"}</p>{esFijo&&item.val&&<p className="text-[9px] text-gray-400">~{fmtS(item.val*26)}/mes</p>}{item.val&&enOf&&<button onClick={()=>aplicar(item.val!,item.modo)} disabled={guardando||Math.abs(Number(c.precio_cliente)-item.val)<0.01} className={`mt-1.5 w-full py-1 rounded-lg text-[10px] font-black text-white disabled:opacity-40 ${item.color==="blue"?"bg-blue-600":item.color==="green"?"bg-green-600":"bg-[#0b315f]"}`}>{Math.abs(Number(c.precio_cliente)-item.val)<0.01?"✓":"Usar"}</button>}</div>))}</div><div className="flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2"><div><p className="text-[10px] text-gray-400 font-bold uppercase">Precio actual</p><p className="font-black text-sm text-gray-800">{fmtS(Number(c.precio_cliente))}{esFijo&&<span className="text-[10px] text-gray-400 font-normal ml-1">/día</span>}</p></div><p className="text-[10px] text-gray-400">Modo: <b>{c.modo_precio||"manual"}</b></p></div>{!c.descuento_solicitado&&!c.descuento_autorizado&&(<div className="border border-dashed border-gray-200 rounded-xl p-2.5"><p className="text-[9px] font-bold text-gray-400 uppercase mb-1.5">🙋 Registrar descuento</p><div className="flex gap-2"><input type="number" min={1} max={50} placeholder="%" value={descPct} onChange={e=>setDescPct(e.target.value)} className="flex-1 border border-gray-200 rounded-xl px-2.5 py-1.5 text-sm outline-none focus:border-[#0b315f]"/><button onClick={solDesc} disabled={guardando||!descPct} className="px-3 py-1.5 rounded-xl font-bold text-xs text-white bg-orange-500 hover:bg-orange-600 disabled:opacity-40">Registrar</button></div></div>)}</div></div>);
}

const MEDIOS_ENVIO=[{id:"WhatsApp",icon:"💬"},{id:"Correo electrónico",icon:"✉️"},{id:"Otros medios",icon:"📋"}];

function ModalEliminar({cot,onConfirmar,onCancelar}:{cot:Cotizacion;onConfirmar:(pass:string)=>Promise<string|null>;onCancelar:()=>void}){
  const[pass,setPass]=useState("");const[err,setErr]=useState("");const[cargando,setCargando]=useState(false);
  const intentar=async()=>{if(!pass){setErr("Ingresa tu contraseña");return;}setCargando(true);setErr("");const r=await onConfirmar(pass);setCargando(false);if(r)setErr(r);};
  return(<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"><div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm"><div className="text-center mb-5"><div className="text-4xl mb-2">🗑️</div><h3 className="text-lg font-black text-gray-800">Eliminar cotización</h3><p className="text-sm text-gray-500 mt-1 font-mono font-bold">#{cot.numero_cotizacion||String(cot.id).padStart(5,"0")}</p><p className="text-xs text-red-600 font-bold mt-2">Esta acción no se puede deshacer</p></div><div className="mb-4"><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Contraseña de administrador</label><input type="password" value={pass} onChange={e=>{setPass(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&intentar()} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-all" placeholder="••••••••" autoFocus/>{err&&<p className="text-xs text-red-600 mt-1.5 font-medium">⚠️ {err}</p>}</div><div className="flex gap-2"><button onClick={onCancelar} className="flex-1 py-2.5 rounded-xl text-sm font-bold border hover:bg-gray-50 text-gray-700">Cancelar</button><button onClick={intentar} disabled={cargando} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{background:"#dc2626"}}>{cargando?"Verificando...":"🗑️ Eliminar"}</button></div></div></div>);
}

function ModalEnvio({onConfirmar,onCancelar}:{onConfirmar:(medio:string)=>void;onCancelar:()=>void}){
  const[medio,setMedio]=useState("");const[detalle,setDetalle]=useState("");const[err,setErr]=useState("");
  const confirmar=()=>{
    if(!medio){setErr("Selecciona un medio de envío");return;}
    if(medio==="Otros medios"&&!detalle.trim()){setErr("Especifica el medio");return;}
    onConfirmar(medio==="Otros medios"?`Otros: ${detalle.trim()}`:medio);
  };
  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{background:"rgba(0,0,0,0.5)"}}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
        <div><h3 className="text-base font-bold text-gray-900">📤 ¿Cómo se envió la cotización?</h3><p className="text-xs text-gray-400 mt-1">Registro obligatorio del medio de envío</p></div>
        <div className="space-y-2">
          {MEDIOS_ENVIO.map(m=>(
            <button key={m.id} onClick={()=>{setMedio(m.id);setErr("");}}
              className="w-full px-4 py-3 rounded-xl border-2 text-sm font-bold text-left transition-all"
              style={{borderColor:medio===m.id?"#0b315f":"#e5e7eb",background:medio===m.id?"#eef3f8":"white",color:medio===m.id?"#0b315f":"#6b7280"}}>
              {m.icon} {m.id}
            </button>
          ))}
        </div>
        {medio==="Otros medios"&&(
          <input autoFocus className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
            placeholder="Especificar medio..." value={detalle} onChange={e=>{setDetalle(e.target.value);setErr("");}}/>
        )}
        {err&&<p className="text-xs text-red-600 font-bold">⚠ {err}</p>}
        <div className="flex gap-3">
          <button onClick={confirmar} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white" style={{background:"#0b315f"}}>✅ Confirmar envío</button>
          <button onClick={onCancelar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function ModalAprobacion({cot,onConfirmar,onCancelar}:{cot:Cotizacion;onConfirmar:(tipo:string,numero:string)=>void;onCancelar:()=>void}){
  const [tipo,setTipo]=useState("Operación bancaria");const [num,setNum]=useState("");const [err,setErr]=useState("");
  return(<div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{background:"rgba(0,0,0,0.5)"}}><div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"><h3 className="text-base font-bold">✅ Aprobar cotización #{cot.numero_cotizacion||cot.id}</h3><div><label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">Tipo de documento *</label><select className={iCls()} value={tipo} onChange={e=>setTipo(e.target.value)}>{TIPOS_APROBACION.map(t=><option key={t}>{t}</option>)}</select></div><div><label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">N° referencia *</label><input className={iCls("font-mono")} placeholder="Número o código" value={num} onChange={e=>{setNum(e.target.value);setErr("");}} autoFocus/>{err&&<p className="text-xs text-red-600 mt-1">⚠ {err}</p>}</div><div className="flex gap-3"><button onClick={()=>num.trim()?onConfirmar(tipo,num.trim()):setErr("Obligatorio")} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-green-700">✅ Confirmar</button><button onClick={onCancelar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600">Cancelar</button></div></div></div>);
}

const PLANTILLAS_INFO=[
  {id:"corporativo",   icon:"🏢",nombre:"Clásico Corporativo",desc:"Formal y sobria",badge:"PRINCIPAL",color:"#0b315f",bg:"#eef3f8"},
  {id:"moderno_fotos", icon:"📸",nombre:"Moderno con Fotos",  desc:"Impacto visual",  badge:null,       color:"#1a1a2e",bg:"#f0f4ff"},
  {id:"turistico",     icon:"🌄",nombre:"Turístico",           desc:"Tours y full day", badge:null,       color:"#b45309",bg:"#fffbeb"},
  {id:"ejecutivo",     icon:"⭐",nombre:"Ejecutivo Premium",  desc:"VIP · ES + EN",   badge:null,       color:"#1a1a1a",bg:"#fafafa"},
];

function ModalPlantilla({cot,plantillaActual,onElegir,onGenerar,onCancelar}:{cot:Cotizacion;plantillaActual:string;onElegir:(id:string)=>void;onGenerar:()=>void;onCancelar:()=>void;}){
  return(
    <div style={{position:"fixed",inset:0,zIndex:60,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px",background:"rgba(0,0,0,0.55)"}}>
      <div style={{background:"white",borderRadius:24,boxShadow:"0 24px 60px rgba(0,0,0,0.2)",width:"100%",maxWidth:520,padding:28}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div><p style={{fontWeight:900,fontSize:17,color:"#1e293b",margin:0}}>📄 Elegir plantilla PDF</p><p style={{color:"#94a3b8",fontSize:12,margin:"3px 0 0"}}>Cotización #{cot.numero_cotizacion||cot.id}</p></div>
          <button onClick={onCancelar} style={{background:"#f1f5f9",border:"none",borderRadius:10,width:32,height:32,cursor:"pointer",fontSize:16,color:"#64748b"}}>✕</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
          {PLANTILLAS_INFO.map(p=>{
            const sel=plantillaActual===p.id;
            return(
              <button key={p.id} onClick={()=>onElegir(p.id)} style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:6,padding:"14px 16px",borderRadius:16,border:`2px solid ${sel?p.color:"#e2e8f0"}`,background:sel?p.bg:"white",cursor:"pointer",textAlign:"left",transition:"all 0.15s",boxShadow:sel?"0 0 0 3px "+p.color+"22":"none"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,width:"100%"}}>
                  <span style={{fontSize:22}}>{p.icon}</span>
                  <div style={{flex:1}}>
                    <p style={{fontWeight:900,fontSize:13,color:sel?p.color:"#1e293b",margin:0}}>{p.nombre}</p>
                    <p style={{color:"#94a3b8",fontSize:11,margin:"1px 0 0"}}>{p.desc}</p>
                  </div>
                  {p.badge&&<span style={{fontSize:9,fontWeight:900,background:p.color,color:"white",padding:"2px 7px",borderRadius:20,flexShrink:0}}>{p.badge}</span>}
                </div>
                {sel&&<span style={{fontSize:10,fontWeight:800,color:p.color}}>✓ Seleccionada</span>}
              </button>
            );
          })}
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onGenerar} style={{flex:1,padding:"12px",borderRadius:14,border:"none",background:"#0b315f",color:"white",fontWeight:900,fontSize:14,cursor:"pointer"}}>
            📄 Generar PDF
          </button>
          <button onClick={onCancelar} style={{padding:"12px 20px",borderRadius:14,border:"1px solid #e2e8f0",background:"white",color:"#64748b",fontWeight:700,fontSize:14,cursor:"pointer"}}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── CardParada: FUERA de ParadasBuilder para evitar pérdida de foco al escribir ──
function CardParada({ p, lbl, col, onUpd, onSel, onDel, mapsLoaded, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isOver }: {
  p: ParadaTP; lbl: string; col: string;
  onUpd: (id: string, k: keyof ParadaTP, v: string) => void;
  onSel: (id: string, r: PlaceResultCot) => void;
  onDel?: () => void;
  mapsLoaded?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
  isOver?: boolean;
}) {
  const inp = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f] bg-white";
  return (
    <div
      className="bg-white rounded-2xl border-2 overflow-hidden transition-all"
      style={{ borderColor: isOver ? "#f59e0b" : col, opacity: isDragging ? 0.45 : 1, boxShadow: isOver ? "0 0 0 3px #f59e0b55" : undefined }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="px-4 py-2.5 flex items-center justify-between" style={{ background: col }}>
        <div className="flex items-center gap-2">
          {draggable && (
            <span className="cursor-grab active:cursor-grabbing text-white/50 hover:text-white select-none text-base leading-none" title="Arrastra para reordenar">⠿</span>
          )}
          <span className="text-white font-black text-sm">{lbl}</span>
        </div>
        {onDel && <button type="button" onClick={onDel} className="text-white/60 hover:text-white font-bold text-xs leading-none px-1">✕</button>}
      </div>
      <div className="p-4 grid gap-3" style={{ gridTemplateColumns: "1fr 120px" }}>
        <div>
          <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Lugar</label>
          {mapsLoaded ? (
            <LocationInputCot placeholder={p.tipo==="intermedia"?"Buscar parada…":"Nombre del punto"} value={p.nombre} mapsLoaded={mapsLoaded}
              onChange={v => onUpd(p.id, "nombre", v)}
              onSelect={r => onSel(p.id, r)} />
          ) : (
            <input className={inp} value={p.nombre} onChange={e => onUpd(p.id, "nombre", e.target.value)} placeholder="—" />
          )}
          {p.lat && p.lng && <p className="text-[9px] text-gray-300 mt-1 font-mono">📍 {Number(p.lat).toFixed(5)}, {Number(p.lng).toFixed(5)}</p>}
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Hora</label>
          <input type="time" className={inp} value={p.hora} onChange={e => onUpd(p.id, "hora", e.target.value)} />
        </div>
      </div>
    </div>
  );
}

function ParadasBuilder({ paradas, onChange, tipo = "solo_ida", mapsLoaded, origenNombre, destinoNombre, origenLat, origenLng, destinoLat, destinoLng, horaIda, horaRetorno }: {
  paradas: ParadaTP[]; onChange: (p: ParadaTP[]) => void; tipo?: string;
  mapsLoaded?: boolean; origenNombre?: string; destinoNombre?: string;
  origenLat?: string; origenLng?: string; destinoLat?: string; destinoLng?: string;
  horaIda?: string; horaRetorno?: string;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const droppedRef = useRef(false);

  const nId = () => Math.random().toString(36).slice(2, 8);
  const upd = (id: string, k: keyof ParadaTP, v: string) =>
    onChange(paradas.map(p => p.id === id ? { ...p, [k]: v } : p));
  // Actualización atómica de nombre+lat+lng para evitar stale closure con 3 setState seguidos
  const sel = (id: string, r: PlaceResultCot) =>
    onChange(paradas.map(p => p.id === id ? { ...p, nombre: r.address, lat: String(r.lat), lng: String(r.lng) } : p));
  const inicio = paradas.find(p => p.tipo === "inicio");
  const fin    = paradas.find(p => p.tipo === "destino");
  const meds   = paradas.filter(p => p.tipo === "intermedia");
  const addMed = () => {
    const n: ParadaTP = { id: nId(), tipo: "intermedia", nombre: "", direccion: "", lat: "", lng: "", hora: "" };
    const idx = paradas.findIndex(p => p.tipo === "destino");
    const a = [...paradas]; a.splice(idx < 0 ? a.length : idx, 0, n); onChange(a);
  };
  const esTP = tipo === "transporte_personal" || tipo === "fijo_multiparada";

  const handleDrop = (toIdx: number) => {
    droppedRef.current = true;
    if (dragIdx !== null && dragIdx !== toIdx) {
      const newMeds = [...meds];
      const [moved] = newMeds.splice(dragIdx, 1);
      newMeds.splice(toIdx, 0, moved);
      onChange([...(inicio ? [inicio] : []), ...newMeds, ...(fin ? [fin] : [])]);
    }
    setDragIdx(null);
    setOverIdx(null);
  };
  const handleDragEnd = () => {
    if (!droppedRef.current) { setDragIdx(null); setOverIdx(null); }
    droppedRef.current = false;
  };

  if (paradas.length === 0) return (
    <div className="rounded-2xl border-2 border-dashed p-5 text-center" style={{ borderColor: "#0b315f33" }}>
      <p className="text-2xl mb-1.5">🗺️</p>
      {(origenNombre || destinoNombre) && (
        <p className="text-xs text-gray-400 mb-3 px-4 truncate">{origenNombre||"—"} → {destinoNombre||"—"}</p>
      )}
      <button type="button" onClick={() => onChange([
        { id: nId(), tipo: "inicio",  nombre: origenNombre||"", direccion: "", lat: origenLat||"", lng: origenLng||"", hora: horaIda||"" },
        { id: nId(), tipo: "destino", nombre: destinoNombre||"", direccion: "", lat: destinoLat||"", lng: destinoLng||"", hora: horaRetorno||"" },
      ])} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90" style={{ background: "#0b315f" }}>
        🚏 {esTP ? "Definir paraderos" : "Definir puntos del recorrido"}
      </button>
    </div>
  );

  return (
    <div className="space-y-3">
      {inicio && <CardParada p={inicio} lbl={esTP ? "🟢 Paradero 1" : "🟢 Inicio"} col="#16a34a" onUpd={upd} onSel={sel} mapsLoaded={mapsLoaded} />}
      {meds.map((p, i) => (
        <CardParada
          key={p.id}
          p={p}
          lbl={`📍 ${esTP ? "Paradero" : "Parada"} ${esTP ? i + 2 : i + 1}`}
          col="#0b315f"
          onUpd={upd}
          onSel={sel}
          onDel={() => onChange(paradas.filter(x => x.id !== p.id))}
          mapsLoaded={mapsLoaded}
          draggable={meds.length > 1}
          onDragStart={() => { droppedRef.current = false; setDragIdx(i); setOverIdx(i); }}
          onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
          onDrop={() => handleDrop(i)}
          onDragEnd={handleDragEnd}
          isDragging={dragIdx === i}
          isOver={overIdx === i && dragIdx !== null && dragIdx !== i}
        />
      ))}
      <button type="button" onClick={addMed} className="w-full py-2.5 rounded-xl border-2 border-dashed font-bold text-sm hover:bg-blue-50 transition-colors" style={{ borderColor: "#0b315f", color: "#0b315f" }}>
        + {esTP ? "Paradero intermedio" : "Parada intermedia"}
      </button>
      {fin && <CardParada p={fin} lbl={esTP ? "🔴 Último Paradero" : "🔴 Destino"} col="#dc2626" onUpd={upd} onSel={sel} mapsLoaded={mapsLoaded} />}
    </div>
  );
}

// ── Helpers para Anexo de Itinerario ──
function formatItinerarioHtml(texto:string,cp:string,acento:string):string{
  return texto.split('\n').map(l=>{
    if(!l.trim())return'<div style="height:5px;"></div>';
    if(/^d[iíI][aA]\s*\d+/i.test(l.trim()))
      return`<div style="margin:16px 0 8px;padding:8px 14px;background:${cp}18;border-left:4px solid ${cp};border-radius:0 8px 8px 0;font-size:13px;font-weight:900;color:${cp};">${l}</div>`;
    const m=l.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.*)/);
    if(m)return`<div style="display:flex;gap:12px;padding:5px 0;border-bottom:1px solid #f3f4f6;"><span style="font-size:10px;font-weight:900;color:${acento};min-width:42px;flex-shrink:0;padding-top:1px;">${m[1]}</span><span style="font-size:11px;">${m[2]}</span></div>`;
    return`<p style="margin:4px 0;font-size:11px;">${l}</p>`;
  }).join('');
}
const LOGO_DEFAULT="/logoafacotizacion-removebg-preview.png";

function buildHeaderPDFHtml(logoUrl:string,cp:string,titulo:string,subtitulo:string):string{
  return`<div class="pdf-header" style="background:${cp};display:flex;align-items:stretch;height:65px;">
    <div style="background:white;border-radius:0 20px 20px 0;padding:8px 20px 8px 14px;display:flex;align-items:center;min-width:140px;max-width:160px;flex-shrink:0;">
      <img src="${logoUrl}" style="max-height:46px;max-width:130px;object-fit:contain;"/>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:flex-end;padding:0 24px;">
      <div style="text-align:right;">
        <p style="font-size:16px;font-weight:900;color:white;margin:0;letter-spacing:.3px;">${titulo}</p>
        <p style="font-size:9.5px;color:rgba(255,255,255,0.72);margin:3px 0 0;">${subtitulo}</p>
      </div>
    </div>
  </div>`;
}
function buildFooterPDFHtml(cp:string,empDir:string,empTel:string,empEmail:string,empWeb:string):string{
  return`<div class="pdf-footer" style="background:${cp};padding:9px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
    <span style="color:white;font-size:8.5px;">&#8962; Dir.: ${empDir}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9990; ${empTel}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9993; ${empEmail}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9741; ${empWeb}</span>
  </div>`;
}
const sharedCSS=(extraCss="")=>`@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0;padding:82px 15mm 55px;line-height:1.4}.pdf-header{position:fixed;top:0;left:0;right:0;z-index:100;}.pdf-footer{position:fixed;bottom:0;left:0;right:0;z-index:100;}.page-break{page-break-before:always}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}${extraCss}`;

function buildAnexoHtml(cot:Cotizacion,nomCl:string,nCot:string,cp:string,acento:string):string{
  const texto=(cot.itinerario_texto||'').trim();if(!texto)return'';
  const itHtml=formatItinerarioHtml(texto,cp,acento);
  const fechaStr=cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase():'';
  return`<div style="page-break-before:always;padding:82px 40px 20px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid ${cp};padding-bottom:12px;margin-bottom:24px;">
      <div>
        <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1.5px;margin:0 0 4px;">ANEXO 1</p>
        <h2 style="font-size:20px;font-weight:900;color:${cp};margin:0;">PROGRAMA DETALLADO</h2>
      </div>
      <div style="text-align:right;">
        <p style="font-size:10px;color:#6b7280;margin:0 0 2px;">N° ${nCot}</p>
        <p style="font-size:12px;font-weight:800;color:${cp};margin:0;">${nomCl}</p>
        ${fechaStr?`<p style="font-size:10px;color:#6b7280;margin:2px 0 0;">${fechaStr}</p>`:''}
      </div>
    </div>
    <div>${itHtml}</div>
  </div>`;
}

function buildCronogramaMultidiaPDF(cot:Cotizacion,cp:string):string{
  const dias=cot.fechas_multidia_json;if(!dias?.length)return'';
  const hasDestino=dias.some(d=>d.destino_nombre?.trim());
  const rows=dias.map((d,i)=>{
    const esUltimo=i===dias.length-1;
    const fechaFmt=d.fecha?new Date(d.fecha+"T00:00:00").toLocaleDateString("es-PE",{weekday:"short",day:"numeric",month:"short",year:"numeric"}).toUpperCase():"—";
    const horaFin=(d as any).hora_fin??(d as any).hora_retorno??"";
    const tipoNoche=(d as any).tipo_noche??(horaFin?"":"pernocte");
    let finLabel="";
    if(esUltimo){finLabel=horaFin?`<b>⏰ ${horaFin}</b> <span style="color:#166534;font-size:9px;">✅ Retorno final</span>`:`<span style="color:#6b7280;font-size:9px;font-style:italic;">Por confirmar</span>`;}
    else if(tipoNoche==="cochera"){finLabel=horaFin?`<b>⏰ ${horaFin}</b> <span style="color:#1d4ed8;font-size:9px;">🏠 Retorno cochera</span>`:`<span style="color:#1d4ed8;font-size:9px;">🏠 Retorno cochera</span>`;}
    else{finLabel=horaFin?`<b>⏰ ${horaFin}</b> <span style="color:#b45309;font-size:9px;">🏨 Pernocte</span>`:`<span style="color:#b45309;font-size:9px;font-style:italic;">🏨 Pernocte</span>`;}
    const origenNombre=i===0?cot.origen:(dias[i-1].destino_nombre||"—");
    const destinoNombre=d.destino_nombre||"—";
    const rutaLabel=hasDestino?`<span style="color:#374151;">${origenNombre}</span><span style="color:${cp};font-weight:900;"> → </span><span style="font-weight:700;">${destinoNombre}</span>`:"";
    return`<tr style="border-bottom:1px solid #f3f4f6;">
      <td style="text-align:center;font-weight:900;font-size:11px;color:${cp};padding:5px 8px;white-space:nowrap;">DÍA ${d.dia}</td>
      <td style="padding:5px 8px;font-size:10px;font-weight:600;">${fechaFmt}</td>
      ${hasDestino?`<td style="padding:5px 8px;font-size:10px;">${rutaLabel}</td>`:""}
      <td style="text-align:center;padding:5px 8px;font-size:10px;">⏰ ${d.hora_ida||"—"}</td>
      <td style="padding:5px 8px;font-size:10px;">${finLabel}</td>
    </tr>`;
  }).join("");
  const colRuta=hasDestino?`<th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">Ruta del día</th>`:"";
  return`<div style="margin:12px 0 16px;background:#fafafa;border:1px solid ${cp}22;border-radius:10px;overflow:hidden;">
    <div style="background:${cp}12;padding:8px 14px;border-bottom:1px solid ${cp}22;">
      <p style="font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.8px;margin:0;">📅 Cronograma del servicio — ${dias.length} días</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:${cp}08;">
        <th style="padding:4px 8px;text-align:center;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">Día</th>
        <th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">Fecha</th>
        ${colRuta}
        <th style="padding:4px 8px;text-align:center;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">H. Salida</th>
        <th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">Fin del día</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildVehsHtml(vehiculos:VehiculoFlota[],cp:string,opts?:{imgH?:string;radius?:string;gap?:string;contain?:boolean}):string{
  if(!vehiculos.length)return"";
  const imgH=opts?.imgH||"200px";const radius=opts?.radius||"12px";const gap=opts?.gap||"12px";const contain=opts?.contain||false;
  return vehiculos.map((veh,idx)=>{
    const esFull=(veh.equipamiento||"full_equipo")==="full_equipo";
    const desc=veh.descripcion_unidad||(esFull?`Bus con capacidad para ${veh.capacidad_pasajeros||"—"} pasajeros, con A/C, sistema de audio, asientos reclinables, bodega y GPS.`:`Bus con capacidad para ${veh.capacidad_pasajeros||"—"} pasajeros, estándar, bodega y GPS.`);
    const mkImg=(url:string)=>contain?`<div style="background:#f3f4f6;border-radius:${radius};border:1px solid #e5e7eb;height:${imgH};display:flex;align-items:center;justify-content:center;overflow:hidden;"><img src="${driveImg(url)}" style="max-width:100%;max-height:${imgH};object-fit:contain;"/></div>`:`<div style="border-radius:${radius};overflow:hidden;height:${imgH};"><img src="${driveImg(url)}" style="width:100%;height:100%;object-fit:cover;"/></div>`;
    const fotos=veh.foto_externa_url||veh.foto_interna_url?`<div style="display:grid;grid-template-columns:${veh.foto_externa_url&&veh.foto_interna_url?"1fr 1fr":"1fr"};gap:${gap};margin:10px 0;">${veh.foto_externa_url?mkImg(veh.foto_externa_url):""}${veh.foto_interna_url?mkImg(veh.foto_interna_url):""}</div>`:"";
    const sep=idx>0?`<div style="height:1px;background:#e5e7eb;margin:10px 0 12px;"></div>`:"";
    const tipoEquip=esFull?"FULL EQUIPO":"BÁSICO";
    const lbl=vehiculos.length>1?`<p style="font-size:10px;font-weight:900;color:${cp};margin:0 0 5px;">${(veh.categoria||"UNIDAD").toUpperCase()} ${tipoEquip}${veh.capacidad_pasajeros?" DE "+veh.capacidad_pasajeros+" PASAJEROS":""}</p>`:"";
    return`${sep}${lbl}<p style="color:#475569;font-size:11px;margin:0;">${desc}</p>${fotos}`;
  }).join("");
}

function generarPDFModerno(cot:Cotizacion,cliente:Cliente|undefined,items:ItemCot[],vehiculos:VehiculoFlota[],repr:string,consid:ConsidCot,cfg:CotPlantillaConfig|null,empresa:EmpresaPerfilPDF|null){
  const conIGV=cot.incluye_igv!==false;
  const{subtotal,igv,total}=calcItems(items,conIGV);
  const nomCl=cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—";
  const nCot=cot.numero_cotizacion||String(cot.id).padStart(5,"0");
  const cp=cfg?.color_primario||"#1a1a2e"; const cs=cfg?.color_secundario||"#2f8ee9";
  const logoUrl=empresa?.logo_url||LOGO_DEFAULT;
  const empNombre=empresa?.nombre||"AFA Tours Peru S.A.C.";
  const empRuc=empresa?.ruc||"20602117091"; const empTel=empresa?.telefono||"966 707 225"; const empEmail=empresa?.email||"transporte@afatoursperu.com";
  const empWeb=empresa?.web||"www.afatoursperu.com";
  const filasItems=items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return`<tr><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">${i+1}. ${it.descripcion}</td><td style="padding:10px 12px;text-align:center;border-bottom:1px solid #f0f0f0;">${it.dias}d × ${it.cantidad}</td><td style="padding:10px 12px;text-align:right;border-bottom:1px solid #f0f0f0;font-weight:700;color:${cp};">S/ ${tf.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;}).join("");
  const inc=(cfg?.condiciones_incluye||consid.incluye).map(i=>`<li style="margin:4px 0;font-size:10px;color:#333;">${i}</li>`).join("");
  const noInc=(cfg?.condiciones_no_incluye||consid.no_incluye).map(i=>`<li style="margin:4px 0;font-size:10px;color:#333;">${i}</li>`).join("");
  const win=window.open("","_blank");if(!win)return;
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Cotización N° ${nCot}</title>
  <style>${sharedCSS()}</style>
  </head><body>
  ${buildHeaderPDFHtml(logoUrl,cp,cfg?.titulo_documento||"PROPUESTA DE SERVICIO",`N° ${nCot} · ${new Date().toLocaleDateString("es-PE")} · Válida 30 días`)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div style="background:#f8fafc;border-radius:12px;padding:16px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 8px;letter-spacing:.8px;">Cliente</p>
        <p style="font-weight:800;font-size:14px;margin:0;">${nomCl}</p><p style="color:#64748b;font-size:10px;margin:3px 0 0;">${cliente?.ruc?"RUC: "+cliente.ruc:cliente?.dni?"DNI: "+cliente.dni:""}${cot.atencion?" · "+cot.atencion:""}</p></div>
      <div style="background:#f8fafc;border-radius:12px;padding:16px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 8px;letter-spacing:.8px;">Servicio</p>
        <p style="font-weight:800;font-size:14px;margin:0;">${cot.origen} → ${cot.destino}</p><p style="color:#64748b;font-size:10px;margin:3px 0 0;">${cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase():"Fecha a coordinar"}${cot.hora_ida?" · "+cot.hora_ida:""}</p></div>
    </div>
    ${buildCronogramaMultidiaPDF(cot,cp)}
    ${vehiculos.length?`<div style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:20px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 12px;letter-spacing:.8px;">Descripción de la unidad${vehiculos.length>1?" · "+vehiculos.length+" vehículos":""}</p>${buildVehsHtml(vehiculos,cp)}</div>`:""}
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <thead><tr style="background:${cp};"><th style="padding:10px 12px;text-align:left;color:white;font-size:10px;font-weight:700;border-radius:8px 0 0 0;">Descripción</th><th style="padding:10px 12px;text-align:center;color:white;font-size:10px;font-weight:700;">Cant.</th><th style="padding:10px 12px;text-align:right;color:white;font-size:10px;font-weight:700;border-radius:0 8px 0 0;">Total</th></tr></thead>
      <tbody>${filasItems}</tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:24px;">
      <div style="background:#f8fafc;border-radius:12px;padding:16px;min-width:220px;">
        ${conIGV?`<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:11px;"><span style="color:#64748b;">Subtotal (sin IGV)</span><span style="font-weight:700;">S/ ${subtotal.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:11px;"><span style="color:#64748b;">IGV 18%</span><span style="font-weight:700;">S/ ${igv.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div>`:""}
        <div style="display:flex;justify-content:space-between;border-top:2px solid ${cp};padding-top:10px;"><span style="font-weight:900;font-size:14px;color:${cp};">TOTAL</span><span style="font-weight:900;font-size:14px;color:${cp};">S/ ${total.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div>
        ${!conIGV?`<p style="font-size:10px;color:#6b7280;margin:6px 0 0;text-align:right;">No incluye IGV</p>`:""}
      </div>
    </div>
    ${items.length>=3||vehiculos.length>=3?`<div style="page-break-before:always;height:70px;margin:0;"></div>`:""}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
      <div><p style="font-weight:900;font-size:10px;color:#166534;text-transform:uppercase;margin:0 0 8px;">✅ Incluye</p><ul style="margin:0;padding-left:16px;">${inc}</ul></div>
      <div><p style="font-weight:900;font-size:10px;color:#991b1b;text-transform:uppercase;margin:0 0 8px;">❌ No incluye</p><ul style="margin:0;padding-left:16px;">${noInc}</ul></div>
    </div>
    ${cfg?.mensaje_cierre?`<p style="text-align:center;color:#64748b;font-style:italic;font-size:11px;margin-bottom:24px;">${cfg.mensaje_cierre}</p>`:""}
  ${buildAnexoHtml(cot,nomCl,nCot,cp,cs)}
  ${buildFooterPDFHtml(cp,empresa?.direccion||"",empTel,empEmail,empWeb)}
  <script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

function generarPDFTuristico(cot:Cotizacion,cliente:Cliente|undefined,items:ItemCot[],vehiculos:VehiculoFlota[],repr:string,consid:ConsidCot,cfg:CotPlantillaConfig|null,empresa:EmpresaPerfilPDF|null){
  const conIGV=cot.incluye_igv!==false;
  const{subtotal,igv,total}=calcItems(items,conIGV);
  const nomCl=cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—";
  const nCot=cot.numero_cotizacion||String(cot.id).padStart(5,"0");
  const cp=cfg?.color_primario||"#b45309"; const cs=cfg?.color_secundario||"#d97706";
  const logoUrl=empresa?.logo_url||LOGO_DEFAULT;
  const empNombre=empresa?.nombre||"AFA Tours Peru S.A.C."; const empTel=empresa?.telefono||"966 707 225"; const empEmail=empresa?.email||"transporte@afatoursperu.com";
  const filasItems=items.map((it)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return`<tr><td style="padding:8px 12px;border-bottom:1px solid #fde68a;">${it.descripcion}<br/><span style="font-size:9px;color:#92400e;">${it.dias} día(s) × ${it.cantidad} unidad(es)</span></td><td style="padding:8px 12px;text-align:right;border-bottom:1px solid #fde68a;font-weight:800;color:${cp};">S/ ${tf.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;}).join("");
  const paradas=cot.paradas_json||[];const paradasHtml=paradas.length>0?`<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:14px;margin-bottom:16px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 10px;">🗺️ Itinerario de paradas</p>${paradas.map((p,i)=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;"><div style="width:24px;height:24px;border-radius:50%;background:${cp};color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;flex-shrink:0;">${i+1}</div><div><p style="font-weight:700;font-size:11px;margin:0;">${p.nombre||p.tipo}</p>${p.hora?`<p style="font-size:10px;color:#92400e;margin:1px 0 0;">🕐 ${p.hora}</p>`:""}</div></div>`).join("")}</div>`:""  ;
  const win=window.open("","_blank");if(!win)return;
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Cotización Turística N° ${nCot}</title>
  <style>${sharedCSS()}</style>
  </head><body>
  ${buildHeaderPDFHtml(logoUrl,cp,cfg?.titulo_documento||"COTIZACIÓN TURÍSTICA",`N° ${nCot} · Válida 30 días`)}
    <div style="background:#fff7ed;border-left:4px solid ${cp};border-radius:0 10px 10px 0;padding:14px 18px;margin-bottom:18px;">
      <p style="font-weight:900;color:${cp};font-size:13px;margin:0 0 4px;">📍 ${cot.origen} → ${cot.destino}</p>
      <p style="color:#92400e;font-size:11px;margin:0;">${cot.hora_ida?"Salida: "+cot.hora_ida:""}${cot.km?" · "+cot.km+" km":""}</p>
    </div>
    ${buildCronogramaMultidiaPDF(cot,cp)}
    ${vehiculos.length?`<div style="margin-bottom:16px;">${buildVehsHtml(vehiculos,cp,{imgH:"180px",radius:"10px",gap:"10px"})}</div>`:""}
    ${paradasHtml}
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
      <thead><tr style="background:${cp};"><th style="padding:9px 12px;text-align:left;color:white;font-size:10px;font-weight:700;">Descripción del servicio</th><th style="padding:9px 12px;text-align:right;color:white;font-size:10px;font-weight:700;">Importe</th></tr></thead>
      <tbody style="background:#fffbeb;">${filasItems}</tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:20px;">
      <div style="background:#fff7ed;border:2px solid ${cs};border-radius:12px;padding:14px 20px;min-width:200px;">
        ${conIGV?`<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;"><span style="color:#92400e;">Subtotal</span><span style="font-weight:700;">S/ ${subtotal.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:10px;"><span style="color:#92400e;">IGV 18%</span><span style="font-weight:700;">S/ ${igv.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div>`:""}
        <div style="display:flex;justify-content:space-between;border-top:2px solid ${cp};padding-top:8px;"><span style="font-weight:900;font-size:15px;color:${cp};">TOTAL</span><span style="font-weight:900;font-size:15px;color:${cp};">S/ ${total.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div>
        ${!conIGV?`<p style="font-size:10px;color:#92400e;margin:6px 0 0;text-align:right;">No incluye IGV</p>`:""}
      </div>
    </div>
    ${items.length>=3||vehiculos.length>=3?`<div style="page-break-before:always;height:70px;margin:0;"></div>`:""}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px;">
      <div style="background:#f0fdf4;border-radius:10px;padding:12px;"><p style="font-weight:900;font-size:10px;color:#166534;margin:0 0 6px;">✅ INCLUYE</p>${(cfg?.condiciones_incluye||consid.incluye).map(i=>`<p style="font-size:10px;color:#166534;margin:2px 0;">• ${i}</p>`).join("")}</div>
      <div style="background:#fff5f5;border-radius:10px;padding:12px;"><p style="font-weight:900;font-size:10px;color:#991b1b;margin:0 0 6px;">❌ NO INCLUYE</p>${(cfg?.condiciones_no_incluye||consid.no_incluye).map(i=>`<p style="font-size:10px;color:#991b1b;margin:2px 0;">• ${i}</p>`).join("")}</div>
    </div>
    ${cfg?.mensaje_cierre?`<p style="text-align:center;color:${cp};font-weight:700;font-size:12px;margin:16px 0;padding:12px;background:#fff7ed;border-radius:10px;">${cfg.mensaje_cierre}</p>`:""}
  ${buildAnexoHtml(cot,nomCl,nCot,cp,cs)}
  ${buildFooterPDFHtml(cp,empresa?.direccion||"",empTel,empEmail,empresa?.web||"www.afatoursperu.com")}
  <script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

function generarPDFEjecutivo(cot:Cotizacion,cliente:Cliente|undefined,items:ItemCot[],vehiculos:VehiculoFlota[],repr:string,consid:ConsidCot,cfg:CotPlantillaConfig|null,empresa:EmpresaPerfilPDF|null){
  const conIGV=cot.incluye_igv!==false;
  const{subtotal,igv,total}=calcItems(items,conIGV);
  const nomCl=cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—";
  const nCot=cot.numero_cotizacion||String(cot.id).padStart(5,"0");
  const cp=cfg?.color_primario||"#1a1a1a"; const acento=cfg?.color_acento||"#C8A24B";
  const logoUrl=empresa?.logo_url||LOGO_DEFAULT;
  const empNombre=empresa?.nombre||"AFA Tours Peru S.A.C."; const empRuc=empresa?.ruc||"20602117091"; const empTel=empresa?.telefono||"966 707 225"; const empEmail=empresa?.email||"transporte@afatoursperu.com";
  const filasItems=items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return`<tr><td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:10.5px;">${it.descripcion}</td><td style="padding:10px 14px;text-align:center;border-bottom:1px solid #f0f0f0;font-size:10px;color:#6b7280;">${it.dias}d × ${it.cantidad}</td><td style="padding:10px 14px;text-align:right;border-bottom:1px solid #f0f0f0;font-weight:800;color:${cp};">S/ ${tf.toLocaleString("es-PE",{minimumFractionDigits:2})}</td><td style="padding:10px 14px;text-align:center;border-bottom:1px solid #f0f0f0;color:#6b7280;font-style:italic;font-size:9.5px;">USD ${(tf/3.7).toFixed(2)}</td></tr>`;}).join("");
  const win=window.open("","_blank");if(!win)return;
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Service Quotation N° ${nCot}</title>
  <style>${sharedCSS()}</style>
  </head><body>
  ${buildHeaderPDFHtml(logoUrl,cp,cfg?.titulo_documento||"SERVICE QUOTATION / COTIZACIÓN",`N° ${nCot} · ${new Date().toLocaleDateString("es-PE")} · Valid 30 days`)}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;">
      <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">CLIENT / CLIENTE</p>
      <p style="font-weight:800;font-size:14px;margin:0;">${nomCl}</p>
      ${cliente?.ruc?`<p style="color:#6b7280;font-size:10px;margin:3px 0 0;">RUC: ${cliente.ruc}</p>`:""}
      ${cot.atencion?`<p style="color:#6b7280;font-size:10px;margin:2px 0 0;">Attn: ${cot.atencion}</p>`:""}
    </div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;">
      <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">${empNombre}</p>
      <p style="color:#6b7280;font-size:10px;margin:2px 0;">RUC: ${empRuc}</p>
      <p style="color:#6b7280;font-size:10px;margin:2px 0;">Repr: ${repr}</p>
      <p style="color:#6b7280;font-size:10px;margin:2px 0;">📞 ${empTel} · ✉️ ${empEmail}</p>
    </div>
  </div>
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:20px;">
    <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">SERVICE DETAILS / DETALLE DEL SERVICIO</p>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
      <div><p style="font-size:9px;color:#6b7280;margin:0;">Origin / Origen</p><p style="font-weight:700;font-size:11px;margin:2px 0 0;">${cot.origen}</p></div>
      <div><p style="font-size:9px;color:#6b7280;margin:0;">Destination / Destino</p><p style="font-weight:700;font-size:11px;margin:2px 0 0;">${cot.destino}</p></div>
      <div><p style="font-size:9px;color:#6b7280;margin:0;">Date / Fecha</p><p style="font-weight:700;font-size:11px;margin:2px 0 0;">${cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}):"—"}</p></div>
    </div>
  </div>
  ${buildCronogramaMultidiaPDF(cot,cp)}
  ${vehiculos.length?`<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:20px;"><p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">UNIT / UNIDAD${vehiculos.length>1?" · "+vehiculos.length+" vehículos":""}</p>${buildVehsHtml(vehiculos,cp,{imgH:"190px",radius:"8px"})}</div>`:""}
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <thead><tr style="border-bottom:2px solid ${acento};"><th style="padding:9px 14px;text-align:left;font-size:9px;font-weight:900;text-transform:uppercase;color:${cp};letter-spacing:.5px;">Description</th><th style="padding:9px 14px;text-align:center;font-size:9px;font-weight:900;text-transform:uppercase;color:${cp};letter-spacing:.5px;">Qty</th><th style="padding:9px 14px;text-align:right;font-size:9px;font-weight:900;text-transform:uppercase;color:${cp};letter-spacing:.5px;">Amount PEN</th><th style="padding:9px 14px;text-align:right;font-size:9px;font-weight:900;text-transform:uppercase;color:#9ca3af;letter-spacing:.5px;">USD ~</th></tr></thead>
    <tbody>${filasItems}</tbody>
  </table>
  <div style="display:flex;justify-content:flex-end;margin-bottom:24px;">
    <div style="min-width:240px;">
      ${conIGV?`<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11px;"><span style="color:#6b7280;">Subtotal (excl. tax)</span><span style="font-weight:700;">S/ ${subtotal.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div><div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11px;"><span style="color:#6b7280;">IGV/Tax 18%</span><span style="font-weight:700;">S/ ${igv.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div>`:""}
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-top:2px solid ${acento};margin-top:4px;"><span style="font-weight:900;font-size:15px;">TOTAL</span><span style="font-weight:900;font-size:15px;color:${cp};">S/ ${total.toLocaleString("es-PE",{minimumFractionDigits:2})}</span></div>
      ${!conIGV?`<p style="font-size:10px;color:#6b7280;margin:4px 0 0;text-align:right;">No incluye IGV</p>`:""}
    </div>
  </div>
  ${items.length>=3||vehiculos.length>=3?`<div style="page-break-before:always;height:70px;margin:0;"></div>`:""}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px;">
    <div><p style="font-size:9px;font-weight:900;color:#166534;text-transform:uppercase;letter-spacing:.5px;margin:0 0 6px;">Includes / Incluye</p>${(cfg?.condiciones_incluye||consid.incluye).map(i=>`<p style="font-size:10px;color:#166534;margin:3px 0;">✓ ${i}</p>`).join("")}</div>
    <div><p style="font-size:9px;font-weight:900;color:#991b1b;text-transform:uppercase;letter-spacing:.5px;margin:0 0 6px;">Not included / No incluye</p>${(cfg?.condiciones_no_incluye||consid.no_incluye).map(i=>`<p style="font-size:10px;color:#991b1b;margin:3px 0;">✗ ${i}</p>`).join("")}</div>
  </div>
  ${cfg?.mensaje_cierre?`<p style="text-align:center;color:#6b7280;font-style:italic;font-size:11px;margin-bottom:20px;border-top:1px solid #e5e7eb;padding-top:14px;">${cfg.mensaje_cierre}</p>`:""}
  ${buildAnexoHtml(cot,nomCl,nCot,cp,acento)}
  ${buildFooterPDFHtml(cp,empresa?.direccion||"",empTel,empEmail,empresa?.web||"www.afatoursperu.com")}
  <script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

// v2: muestra FECHA IDA + FECHA RETORNO separados cuando fecha_retorno está cargado
function generarPDF(cot:Cotizacion,cliente:Cliente|undefined,items:ItemCot[],vehiculos:VehiculoFlota[],repr="JENNY ELYZABETH URBINA AFATA",consid:ConsidCot=DEFAULT_CONSID,plantilla="corporativo",cfg:CotPlantillaConfig|null=null,empresa:EmpresaPerfilPDF|null=null){
  if(plantilla==="moderno_fotos"){generarPDFModerno(cot,cliente,items,vehiculos,repr,consid,cfg,empresa);return;}
  if(plantilla==="turistico"){generarPDFTuristico(cot,cliente,items,vehiculos,repr,consid,cfg,empresa);return;}
  if(plantilla==="ejecutivo"){generarPDFEjecutivo(cot,cliente,items,vehiculos,repr,consid,cfg,empresa);return;}
  // ── plantilla corporativo (original intacta, solo empresa_perfil si existe) ──
  const empNombre=empresa?.nombre||"AFA Tours Peru S.A.C."; const empRuc=empresa?.ruc||"20602117091"; const empEmail=empresa?.email||"transporte@afatoursperu.com"; const empTel=empresa?.telefono||"(01) 3453707 – 966 707 225"; const empDir=empresa?.direccion||"Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana · Lima";
  const conIGV=cot.incluye_igv!==false;
  const{subtotal,igv,total}=calcItems(items,conIGV);const desc=items.reduce((s,it)=>s+it.dias*it.cantidad*it.precio_unit*(it.descuento_pct/100),0);
  const nomCl=cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—";
  const nCot=cot.numero_cotizacion||String(cot.id).padStart(5,"0");const anio=new Date().getFullYear();
  const fechaDoc=cot.created_at?new Date(cot.created_at).toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}):new Date().toLocaleDateString("es-PE");
  const vehsSec=buildVehsHtml(vehiculos,"#0b315f",{imgH:"180px",radius:"8px",contain:true});
  const filasItems=items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return`<tr><td style="text-align:center;padding:6px;border:1px solid #ccc;">${i+1}</td><td style="padding:6px;border:1px solid #ccc;">${it.descripcion}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.dias}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.cantidad}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;">S/ ${it.precio_unit.toLocaleString("es-PE",{minimumFractionDigits:2})}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.descuento_pct>0?it.descuento_pct+"%":""}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;font-weight:bold;">S/ ${tf.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;}).join("");
  const notaFijo=cot.modo_servicio==="fijo"?`<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:8px 12px;margin-top:8px;font-size:10.5px;"><b style="color:#166534;">📅 Servicio Fijo</b> — Precio/día: <b>${fmtS(Number(cot.precio_dia||0))}</b> · Mes est. (×26): <b>${fmtS(Number(cot.precio_mes_estimado||0))}</b></div>`:"";
  const css=sharedCSS(`.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.box{border:1px solid #ccc;border-radius:4px;padding:8px 10px}.box-title{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:6px}.box-row{margin:3px 0;font-size:10.5px}table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10.5px}thead{background:#0b315f;color:white}thead th{padding:6px;text-align:center;font-weight:700;font-size:10px;border:1px solid #0b315f}tbody tr:nth-child(even){background:#f8fafc}.totales td{padding:4px 10px}.totales .label{text-align:right;color:#555;font-weight:600}.totales .valor{text-align:right;font-weight:700}.totales .total-neto{font-size:13px;font-weight:900;color:#0b315f}.totales .sep{border-top:2px solid #0b315f}.cuentas{margin-top:12px;border-top:2px solid #0b315f;padding-top:10px}.cuentas h3{font-size:11px;font-weight:900;color:#0b315f;margin:0 0 6px}.cuentas-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.cuenta-box{border:1px solid #ddd;border-radius:4px;padding:6px 8px}.cuenta-box .banco{font-weight:900;font-size:10px;color:#0b315f;margin-bottom:3px}.cuenta-box p{margin:1px 0;font-size:9.5px}.anexo h3{font-size:10.5px;font-weight:900;margin:8px 0 4px;text-transform:uppercase}.anexo li{font-size:10.5px;color:#333;line-height:1.6}`);
  const totalesCorpHtml=(()=>{let h="<table class=\"totales\">";if(conIGV){h+=`<tr><td class="label">SUBTOTAL</td><td class="valor">S/ ${subtotal.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;if(desc>0)h+=`<tr><td class="label">DESCUENTO</td><td class="valor" style="color:#dc2626;">- S/ ${desc.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;h+=`<tr><td class="label">IGV (18%)</td><td class="valor">S/ ${igv.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;}h+=`<tr class="sep"><td class="label total-neto">TOTAL NETO</td><td class="valor total-neto">S/ ${total.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;if(!conIGV)h+="<tr><td colspan=\"2\" style=\"text-align:right;font-size:9px;color:#6b7280;padding:2px 10px 0;\">No incluye IGV</td></tr>";h+="</table>";return h;})();
  const saltoIncl=items.length>=3||vehiculos.length>=3?'<div style="page-break-before:always;height:70px;margin:0;"></div>':"";
  const win=window.open("","_blank");if(!win)return;
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Cotización N° ${nCot}</title><style>${css}</style></head><body>${buildHeaderPDFHtml(empresa?.logo_url||LOGO_DEFAULT,"#0b315f",`COTIZACIÓN N° ${nCot} - ${anio}`,`Fecha: ${fechaDoc} · Válida 30 días`)}<div class="grid2"><div class="box"><div class="box-title">Datos del cliente</div><div class="box-row"><b>CLIENTE:</b> ${nomCl}</div><div class="box-row"><b>${cliente?.ruc?"RUC":"DNI"}:</b> ${cliente?.ruc||cliente?.dni||"—"}</div><div class="box-row"><b>DIRECCIÓN:</b> ${cliente?.direccion||"—"}</div><div class="box-row"><b>CELULAR:</b> ${cliente?.telefono||"—"}</div><div class="box-row"><b>ATENCIÓN:</b> ${cot.atencion||cliente?.operativo_nombre||"—"}</div></div><div class="box"><div class="box-title">${empNombre}</div><div class="box-row"><b>RUC:</b> ${empRuc}</div><div class="box-row"><b>REPR:</b> ${repr}</div><div class="box-row"><b>EMAIL:</b> ${empEmail}</div><div class="box-row"><b>TELF:</b> ${empTel}</div></div></div><div class="box" style="margin-bottom:10px;"><div class="box-title">Detalle del servicio</div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;"><div class="box-row"><b>ORIGEN:</b> ${cot.origen||"—"}</div><div class="box-row"><b>DESTINO:</b> ${cot.destino||"—"}</div><div class="box-row"><b>RETORNO:</b> ${cot.punto_retorno||cot.origen||"—"}</div></div>${cot.asunto?`<div class="box-row" style="margin-top:4px;"><b>ASUNTO:</b> ${cot.asunto}</div>`:""}${cot.fecha_retorno?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"><div class="box-row"><b>FECHA IDA:</b> ${cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase():"_____________"}</div><div class="box-row"><b>HORA IDA:</b> <b>${cot.hora_ida||"_____"}</b></div><div class="box-row"><b>FECHA RETORNO:</b> ${new Date(cot.fecha_retorno+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase()}</div><div class="box-row"><b>HORA RETORNO:</b> <b>${cot.hora_retorno||"_____"}</b></div></div>`:`<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"><div class="box-row"><b>FECHA:</b> ${cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase():"_____________"}</div><div class="box-row"><b>HORARIO:</b> Salida: <b>${cot.hora_ida||"_____"}</b> | Retorno: <b>${cot.hora_retorno||"_____"}</b></div></div>`}${notaFijo}</div>${buildCronogramaMultidiaPDF(cot,"#0b315f")}<table><thead><tr><th style="width:40px;">ITEM</th><th style="text-align:left;">DESCRIPCIÓN</th><th style="width:45px;">DÍAS</th><th style="width:55px;">CANT.</th><th style="width:110px;">P. UNIT S/ sin IGV</th><th style="width:55px;">% DSCTO.</th><th style="width:110px;">TOTAL S/</th></tr></thead><tbody>${filasItems}<tr><td colspan="7" style="border:1px solid #ccc;padding:0;vertical-align:top;">${totalesCorpHtml}</td></tr></tbody></table><div class="cuentas"><h3>Nuestras cuentas bancarias</h3><div class="cuentas-grid"><div class="cuenta-box"><div class="banco">BCP — Soles</div><p>Cta: 191-2644342-0-24</p><p>CCI: 00219100264434202450</p></div><div class="cuenta-box"><div class="banco">BCP — Dólares</div><p>Cta: 191-7394169-1-83</p><p>CCI: 00219100739416918351</p></div></div></div>${buildAnexoHtml(cot,nomCl,nCot,"#0b315f","#1d4ed8")}<div class="page-break"></div><h2 style="font-size:14px;font-weight:900;color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:6px;margin-bottom:16px;padding-top:82px;">Descripción de la unidad y condiciones</h2>${vehiculos.length?`<div class="box" style="margin-bottom:10px;"><div class="box-title">Características de la unidad${vehiculos.length>1?" · "+vehiculos.length+" vehículos":""}</div><div class="box-row">${vehsSec}</div></div>`:""}`+saltoIncl+`<div class="anexo"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;"><div><h3 style="color:#166534;border-bottom:2px solid #16a34a;padding-bottom:3px;">✅ Servicio incluye</h3><ul>${(cfg?.condiciones_incluye||consid.incluye).map(i=>`<li>${i}</li>`).join("")}</ul></div><div><h3 style="color:#991b1b;border-bottom:2px solid #dc2626;padding-bottom:3px;">❌ No incluye</h3><ul>${(cfg?.condiciones_no_incluye||consid.no_incluye).map(i=>`<li>${i}</li>`).join("")}</ul></div></div><h3 style="color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:3px;">📋 Consideraciones generales</h3><ul>${(cfg?.condiciones_generales||consid.generales).map(i=>`<li>${i}</li>`).join("")}</ul></div>${buildFooterPDFHtml("#0b315f",empDir,empTel,empEmail,empresa?.web||"www.afatoursperu.com")}<script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

type PlaceResultCot={address:string;lat:number;lng:number;placeId:string;};

// Distance Matrix se factura POR ELEMENTO (orígenes × destinos), así que
// memorizamos cada par ya consultado. Los mismos origen-destino se repiten
// muchísimo entre cotizaciones (minas, plantas, hoteles) y así no se vuelven
// a pedir. La clave usa el placeId cuando existe —que es lo que se le manda a
// Google— porque dos accesos distintos del mismo edificio comparten la
// coordenada redondeada (~1 m) y devolverían el km del otro.
const cacheTramosCot=new Map<string,number>();
const clavePuntoCot=(p:{placeId?:string;lat:number;lng:number})=>p.placeId||`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

function useGoogleMapsCot(){
  const[loaded,setLoaded]=useState(false);
  useEffect(()=>{
    if(typeof window==="undefined")return;
    if((window as any).google?.maps?.places){setLoaded(true);return;}
    const ex=document.getElementById("gmaps-script");
    if(ex){const h=()=>setLoaded(true);ex.addEventListener("load",h);return()=>ex.removeEventListener("load",h);}
    const s=document.createElement("script");
    s.id="gmaps-script";
    s.src=`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&language=es&region=PE`;
    s.async=true;s.defer=true;s.onload=()=>setLoaded(true);
    document.head.appendChild(s);
  },[]);
  return loaded;
}

function PlacesInputCot({placeholder,value,onChange,onSelect,mapsLoaded,inputCls}:{
  placeholder:string;value:string;
  onChange:(v:string)=>void;onSelect:(r:PlaceResultCot)=>void;
  mapsLoaded:boolean;inputCls?:string;
}){
  const inputRef=useRef<HTMLInputElement>(null);
  const acRef=useRef<any>(null);
  const cls=inputCls||"w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all pr-8";
  useEffect(()=>{
    if(!mapsLoaded||!inputRef.current||acRef.current)return;
    acRef.current=new (window as any).google.maps.places.Autocomplete(inputRef.current,{
      componentRestrictions:{country:"pe"},
      // `fields` acotado a lo que se usa: el widget factura el getPlace() según
      // las categorías de datos pedidas, y pedir de más sube el costo. No se
      // pasa sessionToken: el widget legacy no lo acepta (no existe en
      // AutocompleteOptions) y ya agrupa su propia sesión internamente.
      fields:["formatted_address","geometry","place_id","name"],
      types:["geocode","establishment"],
    });
    acRef.current.addListener("place_changed",()=>{
      const p=acRef.current.getPlace();
      if(!p.geometry?.location)return;
      const pName=p.name||"";
      const pAddr=p.formatted_address||"";
      // Si el nombre del lugar no está incluido en la dirección (ej: plus codes), preponerlo
      const address=pName&&pAddr&&!pAddr.toLowerCase().includes(pName.toLowerCase())?`${pName}, ${pAddr}`:pAddr||pName;
      onChange(address);
      onSelect({address,lat:p.geometry.location.lat(),lng:p.geometry.location.lng(),placeId:p.place_id||""});
    });
  },[mapsLoaded]);
  return(
    <div className="relative">
      <input ref={inputRef} type="text" value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className={cls+" bg-white"}/>
      {value&&<button type="button" onClick={()=>{onChange("");onSelect({address:"",lat:0,lng:0,placeId:""});}} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 font-bold text-xs">✕</button>}
      {!mapsLoaded&&<div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>}
    </div>
  );
}

function LocationInputCot({placeholder,value,onChange,onSelect,mapsLoaded,inputCls}:{
  placeholder:string;value:string;
  onChange:(v:string)=>void;onSelect:(r:PlaceResultCot)=>void;
  mapsLoaded:boolean;inputCls?:string;
}){
  const[modoCoord,setModoCoord]=useState(false);
  const[latInput,setLatInput]=useState("");
  const[lngInput,setLngInput]=useState("");
  const[buscando,setBuscando]=useState(false);
  const[coordError,setCoordError]=useState("");
  const geocodificar=async()=>{
    const lat=parseFloat(latInput.replace(",","."));
    const lng=parseFloat(lngInput.replace(",","."));
    if(isNaN(lat)||isNaN(lng)){setCoordError("Coordenadas inválidas");return;}
    if(!mapsLoaded||(window as any).google?.maps?.Geocoder===undefined){setCoordError("Google Maps no está listo");return;}
    setBuscando(true);setCoordError("");
    try{
      const geocoder=new (window as any).google.maps.Geocoder();
      const response=await geocoder.geocode({location:{lat,lng},language:"es",region:"PE"});
      const results=response?.results??response;
      if(results&&results[0]){
        const address=results[0].formatted_address;
        const placeId=results[0].place_id||"";
        onChange(address);onSelect({address,lat,lng,placeId});
        setModoCoord(false);setLatInput("");setLngInput("");
      }else{setCoordError("Sin resultados para estas coordenadas");}
    }catch(e:any){
      setCoordError(e?.message||"Error al obtener dirección de Google Maps");
    }finally{setBuscando(false);}
  };
  if(modoCoord){
    return(
      <div>
        <div className="rounded-xl border-2 border-blue-200 bg-blue-50 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase text-blue-600 tracking-wide">📐 Ingresar coordenadas</span>
            <button type="button" onClick={()=>{setModoCoord(false);setCoordError("");}} className="text-[10px] font-bold text-gray-400 hover:text-gray-600">✕ Cancelar</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[9px] font-bold uppercase text-gray-500 mb-1">Latitud</label>
              <input type="text" inputMode="decimal" placeholder="-12.04648" value={latInput}
                onChange={e=>{setLatInput(e.target.value);setCoordError("");}}
                onKeyDown={e=>e.key==="Enter"&&lngInput&&geocodificar()}
                className="w-full border border-blue-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono bg-white" autoFocus/>
            </div>
            <div>
              <label className="block text-[9px] font-bold uppercase text-gray-500 mb-1">Longitud</label>
              <input type="text" inputMode="decimal" placeholder="-77.04280" value={lngInput}
                onChange={e=>{setLngInput(e.target.value);setCoordError("");}}
                onKeyDown={e=>e.key==="Enter"&&latInput&&geocodificar()}
                className="w-full border border-blue-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono bg-white"/>
            </div>
          </div>
          {coordError&&<p className="text-[10px] text-red-500 font-medium">⚠ {coordError}</p>}
          <button type="button" onClick={geocodificar} disabled={!latInput||!lngInput||buscando}
            className="w-full py-2 rounded-xl font-bold text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 transition-colors">
            {buscando?"⏳ Buscando dirección...":"📍 Cargar desde coordenadas"}
          </button>
        </div>
      </div>
    );
  }
  return(
    <div className="space-y-1">
      <PlacesInputCot placeholder={placeholder} value={value} onChange={onChange} onSelect={onSelect} mapsLoaded={mapsLoaded} inputCls={inputCls}/>
      <button type="button" onClick={()=>setModoCoord(true)}
        className="text-[10px] font-semibold text-blue-500 hover:text-blue-700 flex items-center gap-1 transition-colors">
        📐 Usar coordenadas
      </button>
    </div>
  );
}

const DRAFT_KEY="afa_cot_borrador_v1";

export default function CotizacionesPage(){
  const [clientes,setClientes]=useState<Cliente[]>([]);const [cotizas,setCotizas]=useState<Cotizacion[]>([]);const [tarifas,setTarifas]=useState<Tarifa[]>([]);const [flota,setFlota]=useState<VehiculoFlota[]>([]);const [flotaTercero,setFlotaTercero]=useState<VehiculoTerceroFlota[]>([]);const [paramsDB,setParamsDB]=useState<ParamCosto[]>([]);const [preciosDB,setPreciosDB]=useState<Record<string,number>>({});
  const [loading,setLoading]=useState(false);const [guardando,setGuardando]=useState(false);const [mostrarForm,setMostrarForm]=useState(false);const [editandoId,setEditandoId]=useState<number|null>(null);const [busqueda,setBusqueda]=useState("");const [filtroEst,setFiltroEst]=useState("todos");const [filtroModo,setFiltroModo]=useState("todos");
  const [draftRecuperado,setDraftRecuperado]=useState(false);
  const [cfgDefault,setCfgDefault]=useState<CotPlantillaConfig|null>(null);
  const [form,setForm]=useState(FORM0);const [items,setItems]=useState<ItemCot[]>([{...ITEM_VACIO}]);const [modalAprob,setModalAprob]=useState<Cotizacion|null>(null);const [guardarTar,setGuardarTar]=useState(true);const [paradas,setParadas]=useState<ParadaTP[]>([]);const [paradasRetorno,setParadasRetorno]=useState<ParadaTP[]>([]);const [consid,setConsid]=useState<ConsidCot>(DEFAULT_CONSID);const [panelId,setPanelId]=useState<number|null>(null);
  const [diasCond,setDiasCond]=useState(1);const [peajesF,setPeajesF]=useState(0);const [pernocteF,setPernocteF]=useState(0);const [viaticosF,setViaticosF]=useState(0);const [reprNombre,setReprNombre]=useState("JENNY ELYZABETH URBINA AFATA");
  const [modalPlantilla,setModalPlantilla]=useState<Cotizacion|null>(null);const [plantillaElegida,setPlantillaElegida]=useState("corporativo");
  const [modalEnvio,setModalEnvio]=useState<Cotizacion|null>(null);
  const [rolUsuario,setRolUsuario]=useState<string>("operador");
  const [modalEliminar,setModalEliminar]=useState<Cotizacion|null>(null);
  const [modalPropagar,setModalPropagar]=useState<{cotId:number;reservas:{id:number;direccion_servicio:string|null}[];paradasIda:ParadaTP[];paradasRet:ParadaTP[]}|null>(null);
  const [propagando,setPropagando]=useState(false);
  const [vehExpandido,setVehExpandido]=useState(false);
  const [pendDespacho,setPendDespacho]=useState(0);
  const [fechasMultidia,setFechasMultidia]=useState<FechaMultidia[]>([]);
  const skipFechasRef=useRef(false);
  const skipDescRef=useRef(false);
  const skipParadasRef=useRef(false);
  useEffect(()=>{supabase.from("reservas").select("id",{count:"exact",head:true}).eq("origen_despacho",true).is("cotizacion_id",null).then((res: any)=>setPendDespacho((res.count as number)||0));},[]);
  // Deep-link desde Programación: /cotizaciones?buscar=<N°> siembra el buscador.
  // Se lee de window.location (cliente) para no requerir <Suspense> de useSearchParams.
  useEffect(()=>{if(typeof window==="undefined")return;const b=new URLSearchParams(window.location.search).get("buscar");if(b)setBusqueda(b);},[]);
  const mapsLoaded=useGoogleMapsCot();
  const [origenPlace,setOrigenPlace]=useState<{placeId:string;lat:number;lng:number}|null>(null);
  const [destinoPlace,setDestinoPlace]=useState<{placeId:string;lat:number;lng:number}|null>(null);
  // `null` = todavía no hay km calculado por Maps (0 sí es un valor válido: tramos < 500 m).
  const [kmBase,setKmBase]=useState<number|null>(null);
  const [calculandoKm,setCalculandoKm]=useState(false);
  const [errorKm,setErrorKm]=useState("");
  useEffect(()=>{
    // `cancelado` evita que la respuesta de un destino ya cambiado pise el km
    // del destino actual (quedaría un kilometraje equivocado en la cotización).
    let cancelado=false;
    const limpiar=()=>{cancelado=true;};
    // Sin ruta completa no hay consulta en vuelo: se libera el bloqueo de guardado.
    if(!mapsLoaded||!origenPlace||!destinoPlace){setCalculandoKm(false);return limpiar;}
    // Si ya conocemos este par no se vuelve a pedir a Google.
    const clave=`${clavePuntoCot(origenPlace)}>${clavePuntoCot(destinoPlace)}`;
    const hit=cacheTramosCot.get(clave);
    // `undefined` = el par no está en caché; un 0 cacheado sí es un km real y debe escribirse.
    if(hit!==undefined){setErrorKm("");setCalculandoKm(false);setKmBase(hit);return limpiar;}
    const svc=new (window as any).google.maps.DistanceMatrixService();
    const orig=origenPlace.placeId?{placeId:origenPlace.placeId}:{location:{lat:origenPlace.lat,lng:origenPlace.lng}};
    const dest=destinoPlace.placeId?{placeId:destinoPlace.placeId}:{location:{lat:destinoPlace.lat,lng:destinoPlace.lng}};
    setErrorKm("");setCalculandoKm(true);
    svc.getDistanceMatrix({origins:[orig],destinations:[dest],travelMode:(window as any).google.maps.TravelMode.DRIVING,unitSystem:(window as any).google.maps.UnitSystem.METRIC},(resp:any)=>{
      const el=resp?.rows?.[0]?.elements?.[0];
      if(el?.status==="OK"){
        const km=Math.round(el.distance.value/1000);cacheTramosCot.set(clave,km);
        if(!cancelado){setKmBase(km);setErrorKm("");setCalculandoKm(false);}
      }else{
        // Sin respuesta útil (OVER_QUERY_LIMIT, REQUEST_DENIED, red caída, ZERO_RESULTS o
        // NOT_FOUND de campamentos y destinos rurales). Se borra el km para no conservar
        // el del destino anterior y se avisa para que se ingrese a mano.
        if(!cancelado){setKmBase(null);setForm(p=>({...p,km:""}));setErrorKm("⚠️ Google Maps no pudo calcular el kilometraje de esta ruta. Ingrésalo a mano.");setCalculandoKm(false);}
      }
    });
    return limpiar;
  },[mapsLoaded,origenPlace?.placeId,origenPlace?.lat,origenPlace?.lng,destinoPlace?.placeId,destinoPlace?.lat,destinoPlace?.lng]);
  useEffect(()=>{
    if(kmBase===null)return;
    const mult=(form.tipo_servicio==="ida_retorno"||form.tipo_servicio==="transporte_personal")?2:1;
    setForm(p=>({...p,km:String(kmBase*mult)}));
  },[kmBase,form.tipo_servicio]);

  const f=(k:keyof typeof FORM0)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}));
  useEffect(()=>{
    const cargarNombre=async(session:any)=>{if(!session?.user)return;const m=session.user.user_metadata;const fullName=(m?.full_name||m?.name||"").trim();if(fullName){setReprNombre(extraerNombreApellido(fullName));}};
    const{data:{subscription}}=supabase.auth.onAuthStateChange(async(_event,session)=>{await cargarNombre(session);});
    supabase.auth.getSession().then(({data:{session}})=>{cargarNombre(session);});
    return()=>subscription.unsubscribe();
  },[]);
  useEffect(()=>{
    supabase.auth.getSession().then(async({data:{session}})=>{
      if(!session?.user)return;
      const{data}=await supabase.from("usuarios").select("rol").eq("id",session.user.id).maybeSingle();
      if(data?.rol)setRolUsuario(data.rol);
    });
  },[]);

  const cargar=async()=>{
    setLoading(true);
    const[clR,cotR,tR,vR,pR,cR,vtR,empR,plR]=await Promise.all([supabase.from("clientes").select("*").order("nombre").limit(1000),supabase.from("cotizaciones").select("*").order("id",{ascending:false}),supabase.from("tarifario").select("*").eq("activo",true),supabase.from("vehiculos").select("id,placa,categoria,marca,modelo,anio,capacidad_pasajeros,equipamiento,foto_externa_url,foto_interna_url,descripcion_unidad,tipo_vehiculo_costeo").order("placa"),supabase.from("parametros_costos").select("*").eq("activo",true).order("grupo_vehiculo").order("capacidad"),supabase.from("precios_combustible").select("tipo,precio"),supabase.from("vehiculos_tercero").select("id,empresa_id,placa,categoria,marca,modelo,capacidad,estado,foto_externa_url,foto_interna_url,descripcion_unidad,tipo_vehiculo_costeo").neq("estado","inactivo").order("placa"),supabase.from("empresas_tercerizadas").select("id,razon_social").order("razon_social"),supabase.from("cotizacion_plantillas").select("*").eq("id","corporativo").maybeSingle()]);
    setClientes(clR.data||[]);setCotizas(cotR.data||[]);setTarifas(tR.data||[]);setFlota(vR.data||[]);setParamsDB(pR.data||[]);
    const pr:Record<string,number>={};(cR.data||[]).forEach((c:any)=>{pr[c.tipo]=Number(c.precio);});setPreciosDB(pr);
    const emps:any[]=empR.data||[];
    setFlotaTercero((vtR.data||[]).map((v:any)=>({...v,empresa_nombre:emps.find((e:any)=>e.id===v.empresa_id)?.razon_social||"Empresa tercerizada"})));
    const cfg=plR.data as CotPlantillaConfig|null;setCfgDefault(cfg);
    // Actualizar consid con valores de DB si no hay borrador activo y el formulario no está abierto
    setConsid(p=>({
      incluye:cfg?.condiciones_incluye?.length?cfg.condiciones_incluye:p.incluye,
      no_incluye:cfg?.condiciones_no_incluye?.length?cfg.condiciones_no_incluye:p.no_incluye,
      generales:cfg?.condiciones_generales?.length?cfg.condiciones_generales:p.generales,
    }));
    setLoading(false);
  };
  useEffect(()=>{cargar();},[]);

  // Restaurar borrador al montar
  useEffect(()=>{
    try{
      const raw=localStorage.getItem(DRAFT_KEY);if(!raw)return;
      const d=JSON.parse(raw);if(!d?.form)return;
      skipDescRef.current=true;skipParadasRef.current=true;
      setForm(d.form);
      if(d.items?.length)setItems(d.items);
      if(d.consid)setConsid(d.consid);
      if(d.paradas?.length)setParadas(d.paradas);
      if(d.paradasRetorno?.length)setParadasRetorno(d.paradasRetorno);
      if(d.fechasMultidia?.length)setFechasMultidia(d.fechasMultidia);
      if(d.editandoId)setEditandoId(d.editandoId);
      if(d.diasCond)setDiasCond(d.diasCond);
      if(d.peajesF)setPeajesF(d.peajesF);
      if(d.pernocteF)setPernocteF(d.pernocteF);
      if(d.viaticosF)setViaticosF(d.viaticosF);
      setMostrarForm(true);setDraftRecuperado(true);
    }catch{}
  },[]);

  // Guardar borrador mientras el formulario está abierto
  useEffect(()=>{
    if(!mostrarForm)return;
    if(!form.origen&&!form.destino&&!form.cliente_id&&!editandoId)return;
    try{localStorage.setItem(DRAFT_KEY,JSON.stringify({form,items,consid,paradas,paradasRetorno,fechasMultidia,editandoId,diasCond,peajesF,pernocteF,viaticosF,savedAt:new Date().toISOString()}));}catch{}
  },[form,items,consid,paradas,paradasRetorno,mostrarForm,editandoId,diasCond,peajesF,pernocteF,viaticosF]);

  // Auto-construir descripción del primer ítem cuando cambia modo/tipo/equipamiento
  useEffect(()=>{
    if(!mostrarForm)return;
    if(skipDescRef.current){skipDescRef.current=false;return;}
    const servLbl=form.modo_servicio==="fijo"?"SERVICIO DE TRANSPORTE DE PERSONAL":"SERVICIO DE TRANSPORTE TURÍSTICO";
    const tipoNom=paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo)?.nombre||"";
    const equipLbl=form.equipamiento==="full_equipo"?"FULL EQUIPO":form.equipamiento==="basico"?"BASICO":"";
    const autoDesc=tipoNom?`${servLbl} - ${tipoNom}${equipLbl?" "+equipLbl:""}`:servLbl;
    setItems(prev=>{const n=[...prev];if(n[0])n[0]={...n[0],descripcion:autoDesc};return n;});
  },[form.modo_servicio,form.tipo_vehiculo,form.equipamiento,mostrarForm]);

  // Sincronizar Inicio/Destino de paradas con origen/destino del formulario
  useEffect(()=>{
    if(!mostrarForm)return;
    if(skipParadasRef.current){skipParadasRef.current=false;return;}
    setParadas(prev=>{
      if(prev.length===0)return prev;
      let changed=false;
      const next=prev.map(p=>{
        if(p.tipo==="inicio"){
          const nom=!p.nombre?form.origen:p.nombre;
          const lat=origenPlace?.lat!==undefined?String(origenPlace.lat):p.lat;
          const lng=origenPlace?.lng!==undefined?String(origenPlace.lng):p.lng;
          if(nom!==p.nombre||lat!==p.lat||lng!==p.lng){changed=true;return{...p,nombre:nom,lat,lng};}
          return p;
        }
        if(p.tipo==="destino"){
          const nom=!p.nombre?form.destino:p.nombre;
          const lat=destinoPlace?.lat!==undefined?String(destinoPlace.lat):p.lat;
          const lng=destinoPlace?.lng!==undefined?String(destinoPlace.lng):p.lng;
          if(nom!==p.nombre||lat!==p.lat||lng!==p.lng){changed=true;return{...p,nombre:nom,lat,lng};}
          return p;
        }
        return p;
      });
      return changed?next:prev;
    });
  },[form.origen,form.destino,origenPlace,destinoPlace,mostrarForm]);

  const gruposVeh=useMemo(()=>{const m:Record<string,ParamCosto[]>={};paramsDB.forEach(v=>{const g=v.grupo_vehiculo||"Otros";if(!m[g])m[g]=[];m[g].push(v);});return m;},[paramsDB]);
  const updItem=(i:number,k:keyof ItemCot,v:string|number)=>setItems(p=>p.map((it,idx)=>idx===i?{...it,[k]:Number.isNaN(Number(v))?v:Number(v)}:it));
  const addItem=()=>setItems(p=>[...p,{...ITEM_VACIO}]);const delItem=(i:number)=>setItems(p=>p.filter((_,idx)=>idx!==i));
  const{subtotal,igv,total}=calcItems(items,form.incluye_igv);
  const limpiar=()=>{setForm(FORM0);setItems([{...ITEM_VACIO}]);setConsid({incluye:cfgDefault?.condiciones_incluye?.length?cfgDefault.condiciones_incluye:DEFAULT_CONSID.incluye,no_incluye:cfgDefault?.condiciones_no_incluye?.length?cfgDefault.condiciones_no_incluye:DEFAULT_CONSID.no_incluye,generales:cfgDefault?.condiciones_generales?.length?cfgDefault.condiciones_generales:DEFAULT_CONSID.generales});setParadas([]);setParadasRetorno([]);setFechasMultidia([]);setEditandoId(null);setMostrarForm(false);setDiasCond(1);setPeajesF(0);setPernocteF(0);setViaticosF(0);setOrigenPlace(null);setDestinoPlace(null);setKmBase(null);setCalculandoKm(false);setErrorKm("");setVehExpandido(false);setDraftRecuperado(false);try{localStorage.removeItem(DRAFT_KEY);}catch{}window.scrollTo({top:0,behavior:"smooth"});};

  const selVeh=(id:string)=>{setForm(p=>({...p,vehiculo_flota_id:id,vehiculo_tercero_id:""}));if(!id)return;const v=flota.find(v=>v.id===Number(id));if(!v)return;setForm(p=>({...p,vehiculo_flota_id:id,vehiculo_tercero_id:"",equipamiento:v.equipamiento||"full_equipo",tipo_vehiculo:v.tipo_vehiculo_costeo||p.tipo_vehiculo}));};
  const selVehTercero=(id:string)=>{setForm(p=>({...p,vehiculo_tercero_id:id,vehiculo_flota_id:""}));if(!id)return;const v=flotaTercero.find(v=>v.id===Number(id));if(!v)return;setForm(p=>({...p,vehiculo_tercero_id:id,vehiculo_flota_id:"",tipo_vehiculo:v.tipo_vehiculo_costeo||p.tipo_vehiculo}));};
  const aplicarPrecio=(sinIGV:number,fuente:string,costoBase?:number)=>{const esFijo=form.modo_servicio==="fijo";const conIGV=sinIGV*(1+IGV);setItems(prev=>{const n=[...prev];n[0]={...n[0],precio_unit:Math.round(sinIGV*100)/100};return n;});if(costoBase)setForm(p=>({...p,costo_estimado:String(Math.round(costoBase*100)/100)}));if(esFijo)setForm(p=>({...p,precio_dia:String(Math.round(conIGV*100)/100)}));};
  const buscarTarifa=()=>tarifas.find(t=>norm(t.origen)===norm(form.origen)&&norm(t.destino)===norm(form.destino)&&t.tipo_vehiculo===form.tipo_vehiculo&&t.equipamiento===form.equipamiento&&t.tipo_servicio===form.tipo_servicio&&(t.modo||"eventual")===form.modo_servicio)||null;

  const agregarItemItinerario=()=>{setItems(prev=>[...prev,{descripcion:"Itinerario del recorrido:\n- Punto de partida: \n- Parada 1: \n- Parada 2: \n- Destino final: ",dias:1,cantidad:1,precio_unit:0,descuento_pct:0}]);};
  const preLlenarItinerario=()=>{
    const dias=Number(form.dias_servicio)||1;
    const esFD=form.tipo_servicio==="full_day";
    let tpl="";
    if(esFD){
      tpl=`06:00 - Recojo en punto de salida\n08:00 - Llegada a ${form.destino||"[Destino]"}\n09:00 - [Actividad 1]\n12:00 - Almuerzo en [Lugar]\n14:00 - [Actividad 2]\n16:00 - Visita a [Atractivo]\n18:00 - Retorno\n20:00 - Llegada al punto de origen`;
    } else {
      tpl=Array.from({length:dias},(_,i)=>`DÍA ${i+1} — [Título del día]\n07:00 - Desayuno y salida\n09:00 - [Actividad principal]\n12:00 - Almuerzo en [Lugar]\n14:00 - [Actividad tarde]\n18:00 - Alojamiento en [Hotel]\n20:00 - Cena`).join("\n\n");
    }
    setForm(p=>({...p,itinerario_texto:tpl}));
  };

  const updDia=(i:number,k:keyof FechaMultidia,v:string)=>setFechasMultidia(p=>p.map((d,idx)=>idx===i?{...d,[k]:v}:d));
  const updDiaDestino=(i:number,nombre:string,lat:string,lng:string)=>setFechasMultidia(p=>p.map((d,idx)=>idx===i?{...d,destino_nombre:nombre,destino_lat:lat,destino_lng:lng}:d));
  const delDia=(i:number)=>setFechasMultidia(p=>{
    const filtered=p.filter((_,idx)=>idx!==i).map((d,idx)=>({...d,dia:idx+1}));
    if(i===p.length-1&&filtered.length>0){
      // el penúltimo pasa a ser último: hora_fin del form, tipo_noche vacío
      filtered[filtered.length-1]={...filtered[filtered.length-1],hora_fin:form.hora_retorno||"",tipo_noche:""};
    }
    return filtered;
  });
  const addDia=()=>setFechasMultidia(p=>{
    const last=p[p.length-1];
    const sig=last?.fecha?new Date(last.fecha+"T00:00:00"):new Date();
    if(last)sig.setDate(sig.getDate()+1);
    // el que era último pasa a ser intermedio: tipo_noche pernocte por defecto
    const prevActualizado=p.map((d,idx)=>idx===p.length-1?{...d,hora_fin:"",tipo_noche:"pernocte" as const}:d);
    return[...prevActualizado,{dia:p.length+1,fecha:sig.toISOString().split("T")[0],hora_ida:last?.hora_ida||"06:00",hora_fin:form.hora_retorno||"",tipo_noche:"" as const,destino_nombre:"",destino_lat:"",destino_lng:""}];
  });
  const generarCronograma=()=>{
    if(!form.fecha_servicio){alert("Ingresa primero la Fecha inicio");return;}
    const nDias=Number(form.dias_servicio)||1;
    const hIda=form.hora_ida||"06:00";
    const hFin=form.hora_retorno||"";
    const rows:FechaMultidia[]=Array.from({length:nDias},(_,i)=>{
      const d=new Date(form.fecha_servicio+"T00:00:00");
      d.setDate(d.getDate()+i);
      const esUltimo=i===nDias-1;
      return{dia:i+1,fecha:d.toISOString().split("T")[0],hora_ida:hIda,hora_fin:esUltimo?hFin:"",tipo_noche:esUltimo?"":"pernocte",destino_nombre:"",destino_lat:"",destino_lng:""};
    });
    setFechasMultidia(rows);
  };

  const buildPayload=(estadoOverride?:EstadoCot)=>{
    const tarifaEnc=buscarTarifa();const kmNum2=Number(form.km)||0;const esFijo=form.modo_servicio==="fijo";
    const vehParam=paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo);
    const costoCalc=vehParam?calcCostoVeh(vehParam,preciosDB,kmNum2>0?kmNum2:1,diasCond,peajesF,pernocteF,viaticosF):null;
    const precioDiaNum=esFijo?Number(form.precio_dia)||costoCalc?.diaEstIGV:null;
    const precioMesNum=esFijo&&precioDiaNum?precioDiaNum*26:null;
    const{total:tot}=calcItems(items,form.incluye_igv);
    return{
      cliente_id:form.cliente_id?Number(form.cliente_id):null,origen:form.origen.trim(),destino:form.destino.trim(),km:kmNum2,
      precio_cliente:esFijo?(precioDiaNum||tot):tot,costo_estimado:Number(form.costo_estimado||0),
      margen_estimado:esFijo?((precioDiaNum||0)-Number(form.costo_estimado||0)):(tot-Number(form.costo_estimado||0)),
      estado:estadoOverride||form.estado,numero_cotizacion:form.numero_cotizacion.trim()||null,atencion:form.atencion.trim()||null,
      asunto:form.asunto.trim()||null,punto_retorno:esSoloIda?null:form.punto_retorno.trim()||null,
      fecha_servicio:(form.tipo_servicio==="multi_dia"&&fechasMultidia.length>0?fechasMultidia[0].fecha:form.fecha_servicio)||null,
      fecha_retorno:form.tipo_servicio==="multi_dia"?(fechasMultidia.length>0?fechasMultidia[fechasMultidia.length-1].fecha:null):form.fecha_retorno||null,
      hora_ida:(form.tipo_servicio==="multi_dia"&&fechasMultidia.length>0?fechasMultidia[0].hora_ida:form.hora_ida)||null,
      hora_retorno:(form.tipo_servicio==="multi_dia"&&fechasMultidia.length>0?fechasMultidia[fechasMultidia.length-1].hora_fin:form.hora_retorno)||null,
      fechas_multidia_json:form.tipo_servicio==="multi_dia"&&fechasMultidia.length>0?fechasMultidia:null,
      descuento_pct:Number(form.descuento_pct||0),items_json:items,tipo_vehiculo:form.tipo_vehiculo||null,
      tipo_servicio:form.tipo_servicio||null,equipamiento:form.equipamiento||null,
      vehiculo_flota_id:form.vehiculo_flota_id?Number(form.vehiculo_flota_id):null,
      vehiculo_tercero_id:form.vehiculo_tercero_id?Number(form.vehiculo_tercero_id):null,
      consideraciones_json:consid,paradas_json:paradas.length>0?paradas:null,paradas_retorno_json:paradasRetorno.length>0?paradasRetorno:null,modo_servicio:form.modo_servicio,
      dias_servicio:Number(form.dias_servicio)||1,horas_servicio:Number(form.horas_servicio)||8,
      pernocte_costo:pernocteF||null,precio_dia:precioDiaNum,precio_mes_estimado:precioMesNum,
      precio_tarifario:tarifaEnc?tarifaEnc.precio:null,
      precio_cotizador:esFijo?(costoCalc?.diaEstIGV||null):(costoCalc?.totalEst20||null),
      costo_cotizador:costoCalc?.baseCosto||null,margen_cotizador:20,vehiculo_cotizador:vehParam?.nombre||null,
      precio_sugerido:costoCalc?(esFijo?costoCalc.diaEstIGV:costoCalc.totalEst20):null,
      modo_precio:tarifaEnc?"tarifario":"cotizador",incluye_igv:form.incluye_igv,
      itinerario_texto:form.itinerario_texto.trim()||null,
    } as any;
  };

  const guardarBorrador=async()=>{
    if(calculandoKm){alert("⏳ Se está calculando el kilometraje de la ruta. Espera un segundo antes de guardar.");return;}
    if(!form.cliente_id&&!form.origen.trim()&&!form.destino.trim()){alert("⚠️ Ingresa al menos el cliente o la ruta para guardar el borrador");return;}
    setGuardando(true);
    let nombreCreador=reprNombre||"";if(!nombreCreador){try{const{data:{user}}=await supabase.auth.getUser();if(user?.email){const{data:uRow}=await supabase.from("usuarios").select("nombre").eq("email",user.email).maybeSingle();if(uRow?.nombre)nombreCreador=extraerNombreApellido(uRow.nombre);}}catch(e){}}
    const payload={...buildPayload("borrador"),creado_por:nombreCreador||null};
    const{error}=editandoId?await supabase.from("cotizaciones").update(payload).eq("id",editandoId):await supabase.from("cotizaciones").insert(payload);
    if(error){alert(error.message);setGuardando(false);return;}
    limpiar();cargar();setGuardando(false);
  };

  const guardarCotizacion=async()=>{
    // Mientras Maps responde, form.km puede ser el del destino anterior: no se guarda.
    if(calculandoKm){alert("⏳ Se está calculando el kilometraje de la ruta. Espera un segundo antes de guardar.");return;}
    if(!form.origen.trim()){alert("⚠️ Falta el Punto de origen");return;}
    if(!form.destino.trim()){alert("⚠️ Falta el Punto de destino");return;}
    if(!form.cliente_id){alert("⚠️ Falta seleccionar el cliente");return;}
    if(requiereParadas&&paradas.length<2){alert("⚠️ El servicio 'Con Paradas' requiere al menos 2 puntos del recorrido en la sección de paradas");return;}
    const cl=clientes.find(c=>c.id===Number(form.cliente_id));if(cl?.estado==="bloqueado"){alert("Cliente bloqueado.");return;}
    if(items.some(it=>!it.descripcion.trim())){alert("Todos los items necesitan descripción");return;}
    setGuardando(true);
    let nombreCreador=reprNombre||"";if(!nombreCreador){try{const{data:{user}}=await supabase.auth.getUser();if(user?.email){const{data:uRow}=await supabase.from("usuarios").select("nombre").eq("email",user.email).maybeSingle();if(uRow?.nombre)nombreCreador=extraerNombreApellido(uRow.nombre);}}catch(e){}}
    const esFijo=form.modo_servicio==="fijo";
    const payload={...buildPayload(form.estado==="borrador"?"pendiente":undefined),creado_por:nombreCreador||null};
    const{error}=editandoId?await supabase.from("cotizaciones").update(payload).eq("id",editandoId):await supabase.from("cotizaciones").insert(payload);
    if(error){alert(error.message);setGuardando(false);return;}
    // Capturar antes de limpiar() para la propagación
    const cotIdGuardado=editandoId;
    const paradasGuardadas=[...paradas];
    const paradasRetornoGuardadas=[...paradasRetorno];
    const tarifaEnc=buscarTarifa();const vehParam=paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo);
    const costoCalc=vehParam?calcCostoVeh(vehParam,preciosDB,kmNum>0?kmNum:1,diasCond,peajesF,pernocteF,viaticosF):null;
    const precioDiaNum=esFijo?Number(form.precio_dia)||costoCalc?.diaEstIGV:null;
    if(guardarTar&&form.tipo_vehiculo&&form.tipo_servicio&&form.equipamiento&&subtotal>0){const{error:tarErr}=await supabase.from("tarifario").upsert({origen:form.origen.trim().toUpperCase(),destino:form.destino.trim().toUpperCase(),tipo_vehiculo:form.tipo_vehiculo,equipamiento:form.equipamiento,tipo_servicio:form.tipo_servicio,modo:form.modo_servicio,precio:esFijo?(precioDiaNum||subtotal)/1.18:subtotal,moneda:"PEN",confidencial:["full_day","multi_dia"].includes(form.tipo_servicio),incluye_guia:false,incluye_peajes:false,incluye_alimentacion:false,notas:`Cotización ${form.numero_cotizacion||""}`.trim(),activo:true},{onConflict:"origen,destino,tipo_vehiculo,equipamiento,tipo_servicio"});if(tarErr)alert("Error al guardar en tarifario: "+tarErr.message);}
    // Detectar servicios futuros no ejecutados para ofrecer propagación (solo en fijos editados)
    let reservasParaPropagar:{id:number;direccion_servicio:string|null}[]=[];
    if(esFijo&&cotIdGuardado&&(paradasGuardadas.length>0||paradasRetornoGuardadas.length>0)){
      const todayPeru=new Date(Date.now()-5*60*60*1000).toISOString().split("T")[0];
      const{data:afect}=await supabase.from("reservas").select("id,direccion_servicio").eq("cotizacion_id",cotIdGuardado).gte("fecha_servicio",todayPeru).neq("estado","en_curso").neq("estado","finalizada").neq("estado","cancelada");
      reservasParaPropagar=afect||[];
    }
    // ── Sincronizar el CLIENTE a los servicios ya generados desde esta cotización ──────────
    // cliente_id en una reserva es identidad HEREDADA de la cotización (se fija al generar el
    // servicio y jamás se re-sincroniza sola). Si aquí se cambió el cliente y no lo propagamos,
    // Programación seguiría mostrando el cliente viejo (bug reportado con la cotización #00238).
    // Se corrigen los servicios vinculados MENOS cancelados y ya facturados/cobrados (cambiarles
    // el cliente rompería la traza con el comprobante SUNAT ya emitido).
    let clientesResinc=0;
    if(cotIdGuardado){
      const nuevoCliente=payload.cliente_id;
      const vinc:{id:number;cliente_id:number|null;estado:string|null;estado_admin:string|null}[]=[];
      for(let d=0;d<40000;d+=1000){const{data,error:eLee}=await supabase.from("reservas").select("id,cliente_id,estado,estado_admin").eq("cotizacion_id",cotIdGuardado).range(d,d+999);if(eLee)break;vinc.push(...(data||[]));if(!data||data.length<1000)break;}
      const idsResinc=vinc.filter(r=>r.cliente_id!==nuevoCliente&&r.estado!=="cancelada"&&!["facturada","cobrada"].includes(r.estado_admin||"")).map(r=>r.id);
      for(let i=0;i<idsResinc.length;i+=100)await supabase.from("reservas").update({cliente_id:nuevoCliente}).in("id",idsResinc.slice(i,i+100));
      clientesResinc=idsResinc.length;
    }
    limpiar();cargar();setGuardando(false);
    if(clientesResinc>0)alert(`✅ Cliente actualizado en ${clientesResinc} servicio${clientesResinc!==1?"s":""} de Programación vinculado${clientesResinc!==1?"s":""} a esta cotización.`);
    if(reservasParaPropagar.length>0){
      setModalPropagar({cotId:cotIdGuardado!,reservas:reservasParaPropagar,paradasIda:paradasGuardadas,paradasRet:paradasRetornoGuardadas});
    }
  };

  const cambiarEstado=async(cot:Cotizacion,nEst:EstadoCot)=>{
    if(nEst===cot.estado)return;
    if(!TRANSICIONES[cot.estado].includes(nEst)){
      const sig=TRANSICIONES[cot.estado];
      alert(`No se puede pasar de "${ESTADO_CFG[cot.estado].label}" a "${ESTADO_CFG[nEst].label}".\nEl siguiente paso es: ${sig.length?sig.map(s=>ESTADO_CFG[s].label).join(" o "):"estado final"}.`);
      return;
    }
    if(nEst==="aprobado"){setModalAprob(cot);return;}
    if(nEst==="enviado"){setModalEnvio(cot);return;}
    await supabase.from("cotizaciones").update({estado:nEst}).eq("id",cot.id);cargar();
  };
  const confirmarEnvio=async(medio:string)=>{
    if(!modalEnvio)return;
    await supabase.from("cotizaciones").update({estado:"enviado",medio_envio:medio}).eq("id",modalEnvio.id);
    setModalEnvio(null);cargar();
  };
  const confirmarAprob=async(tipo:string,numero:string)=>{if(!modalAprob)return;const{error:cotErr}=await supabase.from("cotizaciones").update({estado:"aprobado",tipo_aprobacion:tipo,numero_aprobacion:numero}).eq("id",modalAprob.id);if(cotErr){alert("Error al aprobar: "+cotErr.message);return;}if(modalAprob.tipo_vehiculo&&modalAprob.tipo_servicio&&modalAprob.equipamiento){const esFijo=modalAprob.modo_servicio==="fijo";const{error:tarErr}=await supabase.from("tarifario").upsert({origen:modalAprob.origen.toUpperCase(),destino:modalAprob.destino.toUpperCase(),tipo_vehiculo:modalAprob.tipo_vehiculo,equipamiento:modalAprob.equipamiento,tipo_servicio:modalAprob.tipo_servicio,modo:modalAprob.modo_servicio||"eventual",precio:esFijo?(Number(modalAprob.precio_dia||0)/1.18):Math.round(Number(modalAprob.precio_cliente)/1.18*100)/100,moneda:"PEN",confidencial:false,incluye_guia:false,incluye_peajes:false,incluye_alimentacion:false,notas:`Aprobada #${modalAprob.numero_cotizacion||modalAprob.id}`,activo:true},{onConflict:"origen,destino,tipo_vehiculo,equipamiento,tipo_servicio"});if(tarErr)alert("Error al guardar en tarifario: "+tarErr.message);}setModalAprob(null);cargar();};
  const confirmarPropagar=async()=>{
    if(!modalPropagar||propagando)return;
    setPropagando(true);
    const{reservas,paradasIda,paradasRet}=modalPropagar;
    const todosIds=reservas.map(r=>r.id);
    const BATCH=100;

    // 1 query: qué reservas ya tienen paradas escaneadas
    const{data:conActividad}=await supabase.from("paradas").select("reserva_id").in("reserva_id",todosIds).eq("estado","completada");
    const idsConActividad=new Set((conActividad||[]).map((p:any)=>p.reserva_id));
    const reservasAfectar=reservas.filter(r=>!idsConActividad.has(r.id));
    const saltadas=reservas.length-reservasAfectar.length;

    if(reservasAfectar.length===0){
      setModalPropagar(null);setPropagando(false);
      alert("Sin cambios — todos los servicios ya tienen actividad registrada.");return;
    }

    const tramoRet=paradasRet.length>0?paradasRet:paradasIda;
    const idsIda=reservasAfectar.filter(r=>r.direccion_servicio!=="retorno").map(r=>r.id);
    const idsRet=reservasAfectar.filter(r=>r.direccion_servicio==="retorno").map(r=>r.id);

    // Actualizar paradas_json en reservas (batch)
    for(let i=0;i<idsIda.length;i+=BATCH)await supabase.from("reservas").update({paradas_json:paradasIda}).in("id",idsIda.slice(i,i+BATCH));
    for(let i=0;i<idsRet.length;i+=BATCH)await supabase.from("reservas").update({paradas_json:tramoRet}).in("id",idsRet.slice(i,i+BATCH));

    // Borrar paradas existentes (batch)
    const idsAfectar=reservasAfectar.map(r=>r.id);
    for(let i=0;i<idsAfectar.length;i+=BATCH)await supabase.from("paradas").delete().in("reserva_id",idsAfectar.slice(i,i+BATCH));

    // Insertar nuevas paradas (batch de 200 filas)
    const filasIda=idsIda.flatMap(rid=>paradasIda.map((p,i)=>({reserva_id:rid,orden:i+1,nombre:p.nombre,direccion:p.direccion||null,lat:p.lat?Number(p.lat):null,lng:p.lng?Number(p.lng):null,hora_estimada:p.hora||null,estado:"pendiente"})));
    const filasRet=idsRet.flatMap(rid=>tramoRet.map((p,i)=>({reserva_id:rid,orden:i+1,nombre:p.nombre,direccion:p.direccion||null,lat:p.lat?Number(p.lat):null,lng:p.lng?Number(p.lng):null,hora_estimada:p.hora||null,estado:"pendiente"})));
    const todasFilas=[...filasIda,...filasRet];
    for(let i=0;i<todasFilas.length;i+=200)await supabase.from("paradas").insert(todasFilas.slice(i,i+200));

    // Sincronizar origen/destino y hora de salida (copias denormalizadas que se muestran en
    // programación/seguimiento). La hora del servicio ES la del primer paradero de su tramo:
    // al reeditar los horarios en la cotización, reservas.hora_servicio se quedaba con la hora
    // vieja y Programación seguía mostrándola aunque los paraderos ya tuvieran la nueva.
    const syncOD=async(ids:number[],tramo:typeof paradasIda)=>{
      if(ids.length===0||tramo.length===0)return;
      const od:Record<string,any>={origen:tramo[0].nombre,destino:tramo[tramo.length-1].nombre};
      const horaSalida=(tramo[0].hora||"").trim();
      if(horaSalida)od.hora_servicio=horaSalida;  // sin hora en el primer paradero no se pisa la actual
      for(let i=0;i<ids.length;i+=BATCH)await supabase.from("reservas").update(od).in("id",ids.slice(i,i+BATCH));
    };
    await syncOD(idsIda,paradasIda);
    await syncOD(idsRet,tramoRet);

    setModalPropagar(null);setPropagando(false);
    alert(`✅ Propagación completada\n• ${reservasAfectar.length} servicio${reservasAfectar.length!==1?"s":""} actualizado${reservasAfectar.length!==1?"s":""}${saltadas>0?`\n• ${saltadas} saltado${saltadas!==1?"s":""} (ya tienen actividad registrada)`:""}`);
  };
  const eliminarCotizacion=async(pass:string):Promise<string|null>=>{
    if(!modalEliminar)return null;
    const{data:{session}}=await supabase.auth.getSession();
    if(!session?.user?.email)return "No hay sesión activa";
    const{error:authErr}=await supabase.auth.signInWithPassword({email:session.user.email,password:pass});
    if(authErr)return "Contraseña incorrecta";
    const{error}=await supabase.from("cotizaciones").delete().eq("id",modalEliminar.id);
    if(error)return "Error al eliminar: "+error.message;
    setModalEliminar(null);cargar();return null;
  };
  const duplicarCotizacion=async(c:Cotizacion)=>{
    const payload:any={cliente_id:c.cliente_id,origen:c.origen,destino:c.destino,km:c.km,precio_cliente:c.precio_cliente,costo_estimado:c.costo_estimado,margen_estimado:c.margen_estimado,estado:"pendiente",numero_cotizacion:null,atencion:c.atencion,asunto:c.asunto?`COPIA — ${c.asunto}`:null,punto_retorno:c.punto_retorno,fecha_servicio:c.fecha_servicio,fecha_retorno:c.fecha_retorno,hora_ida:c.hora_ida,hora_retorno:c.hora_retorno,descuento_pct:c.descuento_pct||0,items_json:c.items_json,tipo_vehiculo:c.tipo_vehiculo,tipo_servicio:c.tipo_servicio,equipamiento:c.equipamiento,vehiculo_flota_id:c.vehiculo_flota_id,vehiculo_tercero_id:c.vehiculo_tercero_id,consideraciones_json:c.consideraciones_json,paradas_json:c.paradas_json,paradas_retorno_json:c.paradas_retorno_json,modo_servicio:c.modo_servicio,dias_servicio:c.dias_servicio||1,horas_servicio:c.horas_servicio||8,pernocte_costo:c.pernocte_costo,precio_dia:c.precio_dia,precio_mes_estimado:c.precio_mes_estimado,precio_tarifario:c.precio_tarifario,precio_cotizador:c.precio_cotizador,precio_sugerido:c.precio_sugerido,incluye_igv:c.incluye_igv!==false,itinerario_texto:c.itinerario_texto,fechas_multidia_json:c.fechas_multidia_json,plantilla_pdf:c.plantilla_pdf||"corporativo"};
    const{error}=await supabase.from("cotizaciones").insert(payload);
    if(error){alert(error.message);return;}
    alert(`✅ Cotización #${c.numero_cotizacion||c.id} duplicada correctamente`);
    cargar();
  };
  const convertirAReserva=async(cot:Cotizacion)=>{
    if(cot.estado!=="aprobado"){alert("Solo cotizaciones aprobadas");return;}
    const{data:existe}=await supabase.from("reservas").select("id").eq("cotizacion_id",cot.id).maybeSingle();
    if(existe){alert("Ya fue convertida en reserva");return;}
    const ps=cot.paradas_json||[];const pI=ps.find(p=>p.tipo==="inicio");
    const its=cot.items_json||[];
    const vehKey=(it:ItemCot)=>it.vehiculo_flota_id?`f_${it.vehiculo_flota_id}`:it.vehiculo_tercero_id?`t_${it.vehiculo_tercero_id}`:"sin";
    const grupos=its.reduce((m,it)=>{const k=vehKey(it);if(!m[k])m[k]=[];m[k].push(it);return m;},{} as Record<string,ItemCot[]>);
    const keys=Object.keys(grupos);
    const useMulti=keys.length>1||(keys.length===1&&keys[0]!=="sin"&&(keys[0].startsWith("f_")||keys[0].startsWith("t_")));
    const basePayload={cliente_id:cot.cliente_id,cotizacion_id:cot.id,origen:pI?.nombre||cot.origen,destino:cot.destino,fecha_servicio:cot.fecha_servicio||new Date().toISOString().split("T")[0],hora_servicio:pI?.hora||cot.hora_ida||"06:00",estado:"pendiente",tipo:"propia",tipo_servicio_detalle:cot.tipo_servicio||null,paradas_json:cot.paradas_json||null,costo_proveedor:0};
    const insertParadas=async(reservaId:number)=>{if(ps.length<1)return;await supabase.from("paradas").insert([...ps.filter(p=>p.tipo==="inicio"),...ps.filter(p=>p.tipo==="intermedia"),...ps.filter(p=>p.tipo==="destino")].map((p,i)=>({reserva_id:reservaId,orden:i+1,nombre:p.nombre,direccion:p.direccion||null,lat:p.lat?Number(p.lat):null,lng:p.lng?Number(p.lng):null,hora_estimada:p.hora||null,estado:"pendiente"})));};
    if(!useMulti){
      const{data:r,error}=await supabase.from("reservas").insert({...basePayload,precio_cliente:cot.precio_cliente,vehiculo_id:cot.vehiculo_flota_id||null,vehiculo_tercero_id:cot.vehiculo_tercero_id||null}).select().single();
      if(error){alert(error.message);return;}
      if(r)await insertParadas(r.id);
      alert(`✅ Reserva creada${ps.length>0?` con ${ps.length} paradas`:""}`);
    } else {
      let count=0;
      for(const k of keys){
        const gItems=grupos[k];
        const{total:gTotal}=calcItems(gItems,cot.incluye_igv!==false);
        const vehFlotaId=k.startsWith("f_")?Number(k.slice(2)):(k==="sin"?cot.vehiculo_flota_id||null:null);
        const vehTercId=k.startsWith("t_")?Number(k.slice(2)):(k==="sin"?cot.vehiculo_tercero_id||null:null);
        const{data:r,error}=await supabase.from("reservas").insert({...basePayload,precio_cliente:gTotal,vehiculo_id:vehFlotaId,vehiculo_tercero_id:vehTercId}).select().single();
        if(error){alert(error.message);return;}
        if(r&&count===0)await insertParadas(r.id);
        count++;
      }
      alert(`✅ ${count} reserva${count>1?"s creadas (una por vehículo)":"creada"}`);
    }
    cargar();
  };
  const editarCot=(c:Cotizacion)=>{setOrigenPlace(null);setDestinoPlace(null);setKmBase(null);setCalculandoKm(false);setErrorKm("");skipDescRef.current=true;skipParadasRef.current=true;setForm({cliente_id:String(c.cliente_id||""),origen:c.origen||"",destino:c.destino||"",km:c.km?String(c.km):"",costo_estimado:c.costo_estimado?String(c.costo_estimado):"",estado:(c.estado||"pendiente") as EstadoCot,numero_cotizacion:c.numero_cotizacion||"",atencion:c.atencion||"",asunto:c.asunto||"",punto_retorno:c.punto_retorno||"",fecha_servicio:c.fecha_servicio||"",fecha_retorno:c.fecha_retorno||"",hora_ida:c.hora_ida||"",hora_retorno:c.hora_retorno||"",descuento_pct:c.descuento_pct?String(c.descuento_pct):"0",tipo_vehiculo:c.tipo_vehiculo||"",equipamiento:c.equipamiento||"full_equipo",vehiculo_flota_id:c.vehiculo_flota_id?String(c.vehiculo_flota_id):"",vehiculo_tercero_id:c.vehiculo_tercero_id?String(c.vehiculo_tercero_id):"",modo_servicio:(c.modo_servicio||"eventual") as ModoServ,tipo_servicio:c.tipo_servicio||"solo_ida",dias_servicio:String(c.dias_servicio||1),horas_servicio:String(c.horas_servicio||8),pernocte_costo:String(c.pernocte_costo||0),precio_dia:c.precio_dia?String(c.precio_dia):"",incluye_igv:c.incluye_igv!==false,itinerario_texto:c.itinerario_texto||""});if(c.items_json?.length)setItems(c.items_json);else{const p=Number(c.precio_cliente||0)/1.18;setItems([{descripcion:c.asunto||`${c.origen}→${c.destino}`,dias:1,cantidad:1,precio_unit:Math.round(p*100)/100,descuento_pct:0}]);}setConsid(c.consideraciones_json||DEFAULT_CONSID);setParadas(c.paradas_json||[]);setParadasRetorno(c.paradas_retorno_json||[]);setVehExpandido(!!c.tipo_vehiculo);skipFechasRef.current=true;setFechasMultidia((c.fechas_multidia_json||[]).map((d:any,idx:number,arr:any[])=>({dia:d.dia,fecha:d.fecha||"",hora_ida:d.hora_ida||"",hora_fin:d.hora_fin??d.hora_retorno??"",tipo_noche:d.tipo_noche!==undefined?d.tipo_noche:(idx===arr.length-1?"":"pernocte"),destino_nombre:d.destino_nombre||"",destino_lat:d.destino_lat||"",destino_lng:d.destino_lng||""})));setEditandoId(c.id);setMostrarForm(true);setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50);};
  const abrirPDF=async(cot:Cotizacion,plantilla:string=plantillaElegida)=>{
    const cl=clientes.find(c=>c.id===cot.cliente_id);
    const its=cot.items_json?.length?cot.items_json:[{descripcion:`${cot.asunto||"SERVICIO"} — ${cot.origen}→${cot.destino}`,dias:1,cantidad:1,precio_unit:cot.precio_cliente/1.18,descuento_pct:0}];
    // Recopilar todos los vehículos únicos: nivel cotización + por ítem
    const vehsMap=new Map<number,VehiculoFlota>();
    const addF=(id?:number|null)=>{if(!id)return;const v=flota.find(v=>v.id===id);if(v)vehsMap.set(v.id,v);};
    const addT=(id?:number|null)=>{if(!id)return;const vt=flotaTercero.find(v=>v.id===id);if(vt)vehsMap.set(-(vt.id),{id:vt.id,placa:vt.placa,categoria:vt.categoria,marca:vt.marca,modelo:vt.modelo,anio:null,capacidad_pasajeros:vt.capacidad,equipamiento:null,foto_externa_url:vt.foto_externa_url||null,foto_interna_url:vt.foto_interna_url||null,descripcion_unidad:vt.descripcion_unidad||`${vt.empresa_nombre||"Tercero"} — ${vt.placa} ${vt.categoria||""} ${vt.marca||""} ${vt.capacidad?`(${vt.capacidad} pax)`:""}`,tipo_vehiculo_costeo:vt.tipo_vehiculo_costeo});};
    const itemsConVeh=its.some(it=>it.vehiculo_flota_id||it.vehiculo_tercero_id);
    if(!itemsConVeh){addF(cot.vehiculo_flota_id);addT(cot.vehiculo_tercero_id);}
    its.forEach(it=>{addF(it.vehiculo_flota_id);addT(it.vehiculo_tercero_id);});
    const vehiculos=[...vehsMap.values()];
    let nombreFinal=(cot as any).creado_por||"";
    if(!nombreFinal){try{const{data:{user}}=await supabase.auth.getUser();if(user?.email){const{data:uRow}=await supabase.from("usuarios").select("nombre").eq("email",user.email).maybeSingle();if(uRow?.nombre)nombreFinal=extraerNombreApellido(uRow.nombre);}}catch(e){}}
    const[{data:empData},{data:cfgData}]=await Promise.all([supabase.from("empresa_perfil").select("nombre,razon_social,ruc,logo_url,telefono,email,direccion,color_primario,web").eq("id",1).maybeSingle(),supabase.from("cotizacion_plantillas").select("*").eq("id",plantilla).maybeSingle()]);
    if(plantilla!=="corporativo")await supabase.from("cotizaciones").update({plantilla_pdf:plantilla}).eq("id",cot.id);
    setModalPlantilla(null);
    const considFinal=editandoId===cot.id?consid:(cot.consideraciones_json||consid);
    generarPDF(cot,cl,its,vehiculos,nombreFinal||"JENNY ELYZABETH URBINA AFATA",considFinal,plantilla,cfgData as CotPlantillaConfig|null,empData as EmpresaPerfilPDF|null);
  };

  const totC=cotizas.length;const pend=cotizas.filter(c=>c.estado==="pendiente").length;const env=cotizas.filter(c=>c.estado==="enviado").length;const apr=cotizas.filter(c=>c.estado==="aprobado").length;const tasa=totC>0?Math.round(apr/totC*100):0;const pendDesc=cotizas.filter(c=>c.descuento_solicitado&&!c.descuento_autorizado).length;
  const nomCl=(id:number|null)=>{const c=clientes.find(cl=>cl.id===id);if(!c)return "Sin cliente";return c.tipo==="b2b"?(c.empresa||c.nombre):c.nombre;};
  const filtradas=cotizas.filter(c=>{const ncl=clientes.find(cl=>cl.id===c.cliente_id);const q=busqueda.toLowerCase();return((ncl?.nombre||"").toLowerCase().includes(q)||c.origen.toLowerCase().includes(q)||c.destino.toLowerCase().includes(q)||(c.numero_cotizacion||"").includes(q)||String(c.id).padStart(5,"0").includes(q))&&(filtroEst==="todos"||c.estado===filtroEst)&&(filtroModo==="todos"||c.modo_servicio===filtroModo||(filtroModo==="eventual"&&!c.modo_servicio));});
  const kmNum=Number(form.km)||0;const vehFloraSel=flota.find(v=>v.id===Number(form.vehiculo_flota_id));const vehTerceroSel=flotaTercero.find(v=>v.id===Number(form.vehiculo_tercero_id));const servsList=form.modo_servicio==="eventual"?SERVS_EVENTUAL:SERVS_FIJO;const esFijoForm=form.modo_servicio==="fijo";
  const esSoloIda=["solo_ida","fijo_solo_ida"].includes(form.tipo_servicio);
  const requiereParadas=["ida_retorno_paradas","fijo_multiparada"].includes(form.tipo_servicio);
  const esTurismo=["full_day","multi_dia"].includes(form.tipo_servicio);

  return(
    <>
      {modalEnvio&&<ModalEnvio onConfirmar={confirmarEnvio} onCancelar={()=>setModalEnvio(null)}/>}
      {modalAprob&&<ModalAprobacion cot={modalAprob} onConfirmar={confirmarAprob} onCancelar={()=>setModalAprob(null)}/>}
      {modalPlantilla&&<ModalPlantilla cot={modalPlantilla} plantillaActual={plantillaElegida} onElegir={setPlantillaElegida} onGenerar={()=>abrirPDF(modalPlantilla,plantillaElegida)} onCancelar={()=>setModalPlantilla(null)}/>}
      {modalEliminar&&<ModalEliminar cot={modalEliminar} onConfirmar={eliminarCotizacion} onCancelar={()=>setModalEliminar(null)}/>}
      {modalPropagar&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-xl shrink-0">📡</div>
              <div>
                <h2 className="text-base font-bold text-gray-900">Propagar cambios de paraderos</h2>
                <p className="text-sm text-gray-500 mt-1">La cotización se guardó correctamente. Se encontraron <span className="font-bold text-[#0b315f]">{modalPropagar.reservas.length} servicio{modalPropagar.reservas.length!==1?"s":""} futuro{modalPropagar.reservas.length!==1?"s":""}</span> pendientes vinculados a esta cotización.</p>
              </div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 space-y-1">
              <p className="font-bold">¿Aplicar los nuevos paraderos a esos servicios?</p>
              <p>• Los servicios <strong>ya ejecutados o en curso</strong> NO serán modificados.</p>
              <p>• Los servicios con <strong>paradas ya escaneadas</strong> tampoco se tocarán.</p>
              <p>• Esta acción reemplaza las paradas de cada servicio futuro.</p>
              <p>• La <strong>hora de salida</strong> de cada servicio se ajusta a la del primer paradero de su tramo.</p>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={()=>setModalPropagar(null)} className="flex-1 py-2.5 px-4 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Solo esta cotización</button>
              <button onClick={confirmarPropagar} disabled={propagando} className="flex-1 py-2.5 px-4 rounded-xl text-sm font-bold text-white disabled:opacity-60" style={{background:"#0b315f"}}>{propagando?"Actualizando...":"Propagar a futuros ("+modalPropagar.reservas.length+")"}</button>
            </div>
          </div>
        </div>
      )}
      <main className="p-3 md:p-6 space-y-4 md:space-y-5 max-w-7xl mx-auto">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div><h1 className="text-xl md:text-3xl font-bold text-gray-900">Cotizaciones</h1><p className="text-sm text-gray-400 mt-1">EVENTUAL · FIJO · {paramsDB.length} vehículos desde Supabase{pendDesc>0&&<span className="ml-2 text-orange-600 font-bold bg-orange-50 px-2 py-0.5 rounded-full text-xs">🙋 {pendDesc} descuento{pendDesc>1?"s":""} pendiente{pendDesc>1?"s":""}</span>}{pendDespacho>0&&<span className="ml-2 text-purple-700 font-bold bg-purple-50 px-2 py-0.5 rounded-full text-xs border border-purple-200">⚡ {pendDespacho} sin cotizar (Despachador)</span>}</p></div>
          <div className="flex gap-2 flex-wrap"><a href="/cotizador" className="px-4 py-2.5 rounded-xl font-bold text-sm border text-[#0b315f] border-[#0b315f] hover:bg-[#eef3f8]">🔧 Cotizador</a><button onClick={()=>{mostrarForm?limpiar():setMostrarForm(true);}} className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{background:mostrarForm?"#6b7280":"#0b315f"}}>{mostrarForm?"✕ Cancelar":"+ Nueva cotización"}</button></div>
        </div>

        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          {[{label:"Total",val:totC,color:"#0b315f",bg:"#eef3f8"},{label:"Eventuales",val:cotizas.filter(c=>!c.modo_servicio||c.modo_servicio==="eventual").length,color:"#0b315f",bg:"#eef3f8"},{label:"Fijos",val:cotizas.filter(c=>c.modo_servicio==="fijo").length,color:"#166534",bg:"#dcfce7"},{label:"Pendientes",val:pend,color:"#854d0e",bg:"#fef9c3"},{label:"Enviadas",val:env,color:"#0369a1",bg:"#e0f2fe"},{label:"Aprobadas",val:apr,color:"#166534",bg:"#dcfce7"},{label:"Tasa",val:`${tasa}%`,color:"#1d4ed8",bg:"#dbeafe"},{label:"Dscto. pend.",val:pendDesc,color:"#d97706",bg:"#fef3c7"}].map(k=>(
            <div key={k.label} className="rounded-xl p-3 border" style={{background:k.bg,borderColor:k.color+"22"}}><p className="text-[10px] font-bold uppercase tracking-wide" style={{color:k.color+"99"}}>{k.label}</p><p className="text-xl font-black mt-0.5" style={{color:k.color}}>{k.val}</p></div>
          ))}
        </section>

        {mostrarForm&&(
          <section className="bg-white rounded-2xl border shadow-sm p-4 md:p-6 space-y-5">
            {draftRecuperado&&(<div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><span>📋</span><span className="text-xs font-bold text-blue-700">Borrador recuperado — continúa donde lo dejaste</span></div><button onClick={limpiar} className="text-xs font-bold text-blue-400 hover:text-blue-700 underline flex-shrink-0">Descartar</button></div>)}
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{background:form.estado==="borrador"?"#6b7280":"#0b315f"}}>{editandoId?"✏️":"📄"}</div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold">{editandoId?(form.estado==="borrador"?"Completar borrador":"Editar cotización"):"Nueva cotización"}</h2>
                  {form.estado==="borrador"&&<span className="px-2 py-0.5 text-[10px] font-black rounded-full border-2 border-dashed" style={{background:"#f3f4f6",color:"#6b7280",borderColor:"#d1d5db"}}>BORRADOR</span>}
                </div>
                <p className="text-xs text-gray-400">{paramsDB.length} vehículos · Precio en tiempo real</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[{id:"eventual",label:"📋 EVENTUAL",sub:"Precio total por evento",color:"#0b315f",bg:"#eef3f8"},{id:"fijo",label:"📅 FIJO",sub:"Precio por día · Contrato mensual",color:"#166534",bg:"#dcfce7"}].map(m=>(
                <button key={m.id} onClick={()=>setForm(p=>({...p,modo_servicio:m.id as ModoServ,tipo_servicio:m.id==="eventual"?"solo_ida":"transporte_personal"}))} className="flex flex-col items-start px-4 py-3 rounded-xl border-2 transition-all text-left" style={{background:form.modo_servicio===m.id?m.bg:"white",borderColor:form.modo_servicio===m.id?m.color:"#e5e7eb",color:form.modo_servicio===m.id?m.color:"#9ca3af"}}>
                  <p className="font-black text-base">{m.label}</p><p className="text-[11px] opacity-70">{m.sub}</p>
                </button>
              ))}
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Cliente" req><div className="flex gap-2"><select className={iCls()} value={form.cliente_id} onChange={e=>{const id=e.target.value;const cl=clientes.find(c=>c.id===Number(id));setForm(p=>({...p,cliente_id:id,incluye_igv:cl?.tipo==="b2b"?true:false}));}}><option value="">— Seleccionar ({clientes.length}) —</option>{clientes.filter(c=>c.estado!=="bloqueado").sort((a,b)=>{const nA=c=>c.tipo==="b2b"?(c.empresa||c.nombre):c.nombre;return nA(a).localeCompare(nA(b));}).map(c=>{const esB2B=c.tipo==="b2b";const label=esB2B?(c.empresa||c.nombre):c.nombre;const doc=esB2B?"":(c.dni?` · DNI ${c.dni}`:"");return<option key={c.id} value={c.id}>{label}{doc}</option>;})}</select><a href="/clientes" target="_blank" rel="noreferrer" className="flex-shrink-0 w-10 h-10 rounded-xl border-2 flex items-center justify-center font-black text-lg" style={{background:"#eef3f8",borderColor:"#0b315f33",color:"#0b315f"}}>+</a></div></Campo>
                <Campo label="N° cotización"><input className={iCls("font-mono")} placeholder="Ej: 10996" value={form.numero_cotizacion} onChange={f("numero_cotizacion")}/></Campo>
                <Campo label="Estado"><select className={iCls()} value={form.estado} onChange={f("estado")}><option value="pendiente">Pendiente</option><option value="enviado">Enviado</option><option value="rechazado">Rechazado</option></select></Campo>
                <Campo label="IGV" span={2}>
                  <div className="flex items-center gap-3 pt-1">
                    <button type="button" onClick={()=>setForm(p=>({...p,incluye_igv:true}))} className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 text-xs font-bold transition-all" style={{background:form.incluye_igv?"#dcfce7":"white",borderColor:form.incluye_igv?"#166534":"#e5e7eb",color:form.incluye_igv?"#166534":"#9ca3af"}}>
                      <span className="text-base">🧾</span> Con IGV (18%)
                    </button>
                    <button type="button" onClick={()=>setForm(p=>({...p,incluye_igv:false}))} className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 text-xs font-bold transition-all" style={{background:!form.incluye_igv?"#fef9c3":"white",borderColor:!form.incluye_igv?"#a16207":"#e5e7eb",color:!form.incluye_igv?"#a16207":"#9ca3af"}}>
                      <span className="text-base">📄</span> Sin IGV
                    </button>
                    {!form.incluye_igv&&<span className="text-[10px] text-amber-700 font-semibold bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">El PDF mostrará "No incluye IGV"</span>}
                  </div>
                </Campo>
                <Campo label="Atención" span={2}><input className={iCls()} placeholder="Nombre del responsable" value={form.atencion} onChange={f("atencion")}/></Campo>
                <Campo label="Asunto"><input className={iCls()} placeholder="Ej: Traslado aeropuerto" value={form.asunto} onChange={f("asunto")}/></Campo>
              </div>
            </div>

            {/* ── TIPO DE SERVICIO ── */}
            <div className="rounded-2xl border-2 p-4" style={{borderColor:"#e0e7ef",background:"#f8fafc"}}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#0b315f] mb-3">Tipo de servicio</p>
              {(()=>{
                const CAT_SCHEME:{[k:string]:{color:string;bg:string;badge:string}}={
                  Traslados:{color:"#0b315f",bg:"#eef3f8",badge:"#dbeafe"},
                  "Ruta Simple":{color:"#0b315f",bg:"#eef3f8",badge:"#dbeafe"},
                  Disposición:{color:"#7c3aed",bg:"#f5f3ff",badge:"#ede9fe"},
                  "Ruta Logística":{color:"#7c3aed",bg:"#f5f3ff",badge:"#ede9fe"},
                  Turismo:{color:"#d97706",bg:"#fffbeb",badge:"#fef3c7"},
                  Retén:{color:"#d97706",bg:"#fffbeb",badge:"#fef3c7"},
                };
                const grupos=servsList.reduce((acc,s)=>{(acc[s.cat]||(acc[s.cat]=[])).push(s);return acc;},{} as Record<string,typeof servsList>);
                return Object.entries(grupos).map(([cat,servs])=>{
                  const sc=CAT_SCHEME[cat]||{color:"#6b7280",bg:"#f3f4f6",badge:"#e5e7eb"};
                  return(
                    <div key={cat} className="mb-3 last:mb-0">
                      <span className="inline-block text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full mb-2" style={{background:sc.badge,color:sc.color}}>{cat}</span>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {servs.map(s=>{const act=form.tipo_servicio===s.id;return(
                          <button key={s.id} onClick={()=>setForm(p=>({...p,tipo_servicio:s.id}))} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 transition-all text-left" style={{background:act?sc.bg:"white",borderColor:act?sc.color:"#e5e7eb",color:act?sc.color:"#9ca3af"}}>
                            <span className="font-bold text-sm">{s.label}</span>
                          </button>
                        );})}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* ── TIPO DE MOVILIDAD ── */}
            <div className="rounded-2xl border-2 p-4" style={{borderColor:"#e9d5ff",background:"#faf5ff"}}>
              <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{color:"#7c3aed"}}>Tipo de movilidad</p>
              <div className="flex gap-2">
                {[{val:"full_equipo",label:"⭐ Full Equipo",sub:"AC · TV · USB · GPS",color:"#7c3aed",bg:"#f5f3ff"},{val:"basico",label:"📦 Básico",sub:"Estándar — cumple ley",color:"#4b5563",bg:"#f3f4f6"}].map(e=>{
                  const act=form.equipamiento===e.val;
                  return(
                    <button key={e.val} onClick={()=>setForm(p=>({...p,equipamiento:e.val}))} className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 transition-all" style={{background:act?e.bg:"white",borderColor:act?e.color:"#e5e7eb",color:act?e.color:"#9ca3af"}}>
                      <div><p className="font-bold text-xs">{e.label}</p><p className="text-[10px] opacity-70">{e.sub}</p></div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── VEHÍCULOS ── */}
            <div className="rounded-2xl border-2 overflow-hidden" style={{borderColor:"#e5e7eb"}}>
              <button className="w-full flex items-center justify-between px-4 py-3 transition-colors hover:bg-gray-50" style={{background:"#f9fafb"}} onClick={()=>setVehExpandido(v=>!v)}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-black text-gray-700">🚌 Vehículo de tarifa</span>
                  <span className="text-[10px] text-gray-400 font-normal">({paramsDB.length} disponibles)</span>
                  {form.tipo_vehiculo&&<span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{background:"#eef3f8",color:"#0b315f"}}>{paramsDB.find(v=>v.tipo_vehiculo===form.tipo_vehiculo)?.nombre||form.tipo_vehiculo}</span>}
                  {!form.tipo_vehiculo&&<span className="text-[10px] text-amber-600 font-semibold">Sin asignar</span>}
                </div>
                <span className="text-gray-400 text-xs font-bold">{vehExpandido?"▲ Colapsar":"▼ Expandir"}</span>
              </button>
              {vehExpandido&&(
                <div className="p-4 space-y-2 border-t" style={{borderColor:"#e5e7eb"}}>
                  {Object.entries(gruposVeh).map(([grupo,vehs])=>{const gc=GRUPO_COLOR[grupo]||GRUPO_COLOR.Otros;return(
                    <div key={grupo}>
                      <p className="text-[9px] font-black uppercase tracking-wider mb-1" style={{color:gc.color}}>{grupo}</p>
                      <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5">
                        {vehs.map(v=>{const act=form.tipo_vehiculo===v.tipo_vehiculo;return(
                          <button key={v.tipo_vehiculo} onClick={()=>{setForm(p=>({...p,tipo_vehiculo:v.tipo_vehiculo}));setVehExpandido(false);}} className="flex flex-col items-center px-1 py-2 rounded-xl border-2 transition-all text-center" style={{background:act?gc.bg:"white",borderColor:act?gc.color:"#e5e7eb",color:act?gc.color:"#9ca3af"}}>
                            <span className="text-base">{v.icono||"🚌"}</span>
                            <span className="text-[8px] font-bold leading-tight">{v.nombre}</span>
                            {v.usa_urea&&<span className="text-[7px] text-cyan-600 font-bold">🧪</span>}
                          </button>
                        );})}
                      </div>
                    </div>
                  );})}
                </div>
              )}
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Unidad de flota <span className="normal-case font-normal text-blue-500">→ fotos en PDF</span></p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label={`Vehículo propio (${flota.length})`}>
                  <select className={iCls()} value={form.vehiculo_flota_id} onChange={e=>selVeh(e.target.value)}>
                    <option value="">Sin vehículo propio</option>
                    {flota.map(v=><option key={v.id} value={v.id}>{v.placa} — {v.categoria} {v.marca} {v.modelo} {v.capacidad_pasajeros?`(${v.capacidad_pasajeros}p)`:""}{v.foto_externa_url?" · 📸":""}</option>)}
                  </select>
                </Campo>
                <Campo label={`Vehículo tercerizado (${flotaTercero.length})`}>
                  <select className={iCls()} value={form.vehiculo_tercero_id} onChange={e=>selVehTercero(e.target.value)}>
                    <option value="">Sin vehículo tercerizado</option>
                    {flotaTercero.map(v=><option key={v.id} value={v.id}>{v.placa} — {v.empresa_nombre||"Tercero"} · {v.categoria||""} {v.marca||""}{v.capacidad?` (${v.capacidad}p)`:""}</option>)}
                  </select>
                </Campo>
                {vehFloraSel&&<div className="rounded-xl border-2 p-3" style={{background:"#eef3f8",borderColor:"#0b315f33"}}><p className="text-[10px] font-bold uppercase text-[#0b315f] mb-1">🚌 {vehFloraSel.placa}</p><p className="text-xs text-gray-500">{vehFloraSel.marca} {vehFloraSel.modelo}</p><div className="flex gap-2 text-[10px] mt-1">{vehFloraSel.foto_externa_url&&<span className="text-green-600 font-bold">📸 Exterior ✓</span>}{vehFloraSel.foto_interna_url&&<span className="text-green-600 font-bold">📸 Interior ✓</span>}</div></div>}
                {vehTerceroSel&&<div className="rounded-xl border-2 p-3" style={{background:"#fef9c3",borderColor:"#ca8a0433"}}><p className="text-[10px] font-bold uppercase text-amber-700 mb-1">🤝 {vehTerceroSel.placa} · Tercero</p><p className="text-xs text-gray-500">{vehTerceroSel.empresa_nombre}</p><p className="text-[10px] text-gray-400 mt-0.5">{vehTerceroSel.categoria} {vehTerceroSel.marca}{vehTerceroSel.capacidad?` · ${vehTerceroSel.capacidad} pax`:""}</p></div>}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between border-b pb-1 mb-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Ruta del servicio</p>
                {mapsLoaded?<span className="text-[9px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">Google Maps activo</span>:<span className="text-[9px] text-gray-400 animate-pulse">Cargando Maps...</span>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Punto de origen" req>
                  <LocationInputCot placeholder="Av. República de Panamá 3623" value={form.origen} mapsLoaded={mapsLoaded}
                    onChange={v=>{setForm(p=>({...p,origen:v,km:""}));setOrigenPlace(null);setKmBase(null);setErrorKm("");}}
                    onSelect={p=>{setOrigenPlace(p.placeId?{placeId:p.placeId,lat:p.lat,lng:p.lng}:{placeId:"",lat:p.lat,lng:p.lng});if(p.address)setForm(prev=>({...prev,origen:p.address}));}}/>
                </Campo>
                <Campo label="Punto de destino" req>
                  <LocationInputCot placeholder="Planta Cajamarquilla" value={form.destino} mapsLoaded={mapsLoaded}
                    onChange={v=>{setForm(p=>({...p,destino:v,km:""}));setDestinoPlace(null);setKmBase(null);setErrorKm("");}}
                    onSelect={p=>{setDestinoPlace(p.placeId?{placeId:p.placeId,lat:p.lat,lng:p.lng}:{placeId:"",lat:p.lat,lng:p.lng});if(p.address)setForm(prev=>({...prev,destino:p.address}));}}/>
                </Campo>
                {!esSoloIda&&<Campo label="Punto de retorno">
                  <LocationInputCot placeholder="Igual al origen" value={form.punto_retorno} mapsLoaded={mapsLoaded}
                    onChange={v=>setForm(p=>({...p,punto_retorno:v}))}
                    onSelect={p=>{setForm(prev=>({...prev,punto_retorno:p.address}));}}/>
                </Campo>}
                <Campo label={form.tipo_servicio==="multi_dia"?"Fecha inicio (Día 1)":"Fecha de servicio"}><input type="date" className={iCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")}/></Campo>
                {["ida_retorno","ida_retorno_paradas","multi_dia"].includes(form.tipo_servicio)&&(
                  <Campo label={form.tipo_servicio==="multi_dia"?"Fecha retorno (último día)":"Fecha de retorno"}>
                    <input type="date" className={iCls()} value={form.fecha_retorno} onChange={f("fecha_retorno")}/>
                  </Campo>
                )}
                <Campo label={form.tipo_servicio==="multi_dia"?"H. salida (por defecto)":"Hora de ida"}><input type="time" className={iCls()} value={form.hora_ida} onChange={f("hora_ida")}/></Campo>
                {!esSoloIda&&<Campo label={form.tipo_servicio==="multi_dia"?"H. retorno (último día)":"Hora de retorno"}><input type="time" className={iCls()} value={form.hora_retorno} onChange={f("hora_retorno")}/></Campo>}
                {form.tipo_servicio==="multi_dia"&&<div className="md:col-span-3 mt-1">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">📅 Cronograma detallado</p>
                    <button type="button" onClick={generarCronograma} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black text-white bg-[#0b315f] hover:bg-[#0b315f]/80 transition-colors">⚡ Generar desde fecha inicio</button>
                  </div>
                  <div className="rounded-xl overflow-hidden border border-gray-200 bg-white overflow-x-auto">
                    <div className="min-w-[600px]">
                    <div className="grid gap-0 text-[9px] font-black uppercase tracking-wide text-gray-400 bg-gray-50 px-3 py-2 border-b border-gray-200" style={{gridTemplateColumns:"44px 120px 1fr 76px 116px 28px"}}>
                      <span>Día</span><span>Fecha</span>
                      <span className="pl-1">Destino del día <span className="font-normal normal-case text-gray-300">← Places</span></span>
                      <span className="text-center">H. Salida</span>
                      <span className="text-center">Fin del día</span>
                      <span></span>
                    </div>
                    {fechasMultidia.length===0&&<div className="text-center py-8 text-gray-400 text-xs">Usa el botón "Generar desde fecha inicio" o agrega días manualmente</div>}
                    {fechasMultidia.map((dia,i)=>{
                      const esUltimo=i===fechasMultidia.length-1;
                      return(
                      <div key={i} className="grid gap-1.5 items-center px-2 py-2 border-b border-gray-100 last:border-0" style={{gridTemplateColumns:"44px 120px 1fr 76px 116px 28px"}}>
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-[11px] font-black text-[#0b315f]">D{dia.dia}</span>
                          {dia.destino_lat&&<span className="text-[8px] text-green-500">📍</span>}
                        </div>
                        <input type="date" value={dia.fecha} onChange={e=>updDia(i,"fecha",e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f] focus:ring-1 focus:ring-[#0b315f]/20"/>
                        <PlacesInputCot
                          placeholder={i===0?`Desde ${form.origen||"origen"} →`:`Desde ${fechasMultidia[i-1]?.destino_nombre||"día anterior"} →`}
                          value={dia.destino_nombre}
                          mapsLoaded={mapsLoaded}
                          inputCls="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f] focus:ring-1 focus:ring-[#0b315f]/20 pr-6 bg-white"
                          onChange={v=>updDia(i,"destino_nombre",v)}
                          onSelect={r=>{if(r.lat)updDiaDestino(i,r.address,String(r.lat),String(r.lng));}}
                        />
                        <input type="time" value={dia.hora_ida} onChange={e=>updDia(i,"hora_ida",e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f] focus:ring-1 focus:ring-[#0b315f]/20"/>
                        {/* Fin del día: hora + tipo_noche */}
                        <div className="flex flex-col gap-0.5">
                          <input type="time" value={dia.hora_fin} onChange={e=>updDia(i,"hora_fin",e.target.value)}
                            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f] focus:ring-1 focus:ring-[#0b315f]/20"/>
                          {esUltimo
                            ? <span className="text-[9px] font-bold text-green-600 text-center">✅ Retorno final</span>
                            : <div className="grid grid-cols-2 gap-0.5">
                                <button type="button" onClick={()=>updDia(i,"tipo_noche","pernocte")}
                                  className={`py-0.5 rounded text-[9px] font-bold transition-colors ${dia.tipo_noche==="pernocte"||dia.tipo_noche===""?"bg-amber-100 text-amber-700 border border-amber-300":"bg-gray-100 text-gray-400 border border-gray-200 hover:bg-amber-50"}`}>
                                  🏨 Fuera
                                </button>
                                <button type="button" onClick={()=>updDia(i,"tipo_noche","cochera")}
                                  className={`py-0.5 rounded text-[9px] font-bold transition-colors ${dia.tipo_noche==="cochera"?"bg-blue-100 text-blue-700 border border-blue-300":"bg-gray-100 text-gray-400 border border-gray-200 hover:bg-blue-50"}`}>
                                  🏠 Base
                                </button>
                              </div>
                          }
                        </div>
                        <button type="button" onClick={()=>delDia(i)} className="w-7 h-7 rounded-lg text-red-400 hover:bg-red-50 font-bold text-xs flex items-center justify-center">✕</button>
                      </div>
                      );
                    })}
                    <div className="px-3 py-2 bg-gray-50 flex items-center justify-between border-t border-gray-100">
                      <button type="button" onClick={addDia} className="text-xs font-bold text-[#0b315f] hover:underline">+ Agregar día</button>
                      <p className="text-[9px] text-gray-400 hidden sm:block">🏨 Fuera = pernocte · 🏠 Base = cochera</p>
                    </div>
                    </div>
                  </div>
                </div>}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Parámetros de costing</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Campo label={esFijoForm?"Km diarios":"Km del servicio"} req hint={calculandoKm?"⏳ Calculando con Google Maps...":errorKm||(kmBase!==null?"📍 Calculado con Google Maps":undefined)}><input type="number" min={0} className={iCls("font-mono"+(errorKm?" border-red-300 bg-red-50":calculandoKm?" border-amber-300 bg-amber-50":kmBase!==null?" border-green-300 bg-green-50":""))} placeholder="0" value={form.km} onChange={e=>{setForm(p=>({...p,km:e.target.value}));setKmBase(null);setErrorKm("");}}/></Campo>
                <Campo label="Días de conductor"><div className="flex items-center gap-1"><button onClick={()=>setDiasCond(Math.max(1,diasCond-1))} className="w-9 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold">-</button><span className="flex-1 text-center font-black text-[#0b315f]">{diasCond}</span><button onClick={()=>setDiasCond(Math.min(30,diasCond+1))} className="w-9 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold">+</button></div></Campo>
                <Campo label="Peajes S/"><input type="number" min={0} className={iCls()} placeholder="0" value={peajesF||""} onChange={e=>setPeajesF(Number(e.target.value))}/></Campo>
                <Campo label="Costo interno S/"><input type="number" min={0} className={iCls()} placeholder="0" value={form.costo_estimado} onChange={f("costo_estimado")}/></Campo>
              </div>
              {!esFijoForm&&form.tipo_servicio==="multi_dia"&&<div className="mt-3 rounded-xl bg-purple-50 border border-purple-200 p-4 grid grid-cols-2 gap-4"><p className="col-span-2 text-[10px] font-black text-purple-700 uppercase">🏕️ Costos multi-día</p><Campo label="Pernocte bus S/"><input type="number" min={0} className={iCls()} value={pernocteF||""} onChange={e=>setPernocteF(Number(e.target.value))}/></Campo><Campo label="Viáticos chofer S/"><input type="number" min={0} className={iCls()} value={viaticosF||""} onChange={e=>setViaticosF(Number(e.target.value))}/></Campo></div>}
              {esFijoForm&&<div className="mt-3 rounded-xl bg-green-50 border border-green-200 p-4 grid grid-cols-2 gap-4 items-end"><Campo label="Precio/día confirmado S/ (con IGV)"><input type="number" min={0} className={iCls("font-mono font-bold")} placeholder="0.00" value={form.precio_dia} onChange={f("precio_dia")}/></Campo>{form.precio_dia&&Number(form.precio_dia)>0&&<div className="rounded-xl bg-green-100 border border-green-300 px-4 py-3"><p className="text-[10px] font-bold text-green-700 uppercase">Estimado mensual (×26)</p><p className="font-black text-xl text-green-700">{fmtS(Number(form.precio_dia)*26)}</p></div>}</div>}
            </div>

            {form.tipo_vehiculo&&<SugerenciaEnVivo origen={form.origen} destino={form.destino} tipoVehId={form.tipo_vehiculo} tipoServ={form.tipo_servicio} equip={form.equipamiento} km={kmNum} dias={diasCond} peajes={peajesF} pernocte={pernocteF} viaticos={viaticosF} modoServ={form.modo_servicio} tarifas={tarifas} paramsDB={paramsDB} preciosDB={preciosDB} onAplicar={aplicarPrecio}/>}

            <div>
              <div className="flex items-center justify-between border-b pb-1 mb-3"><p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Items</p><button onClick={addItem} className="text-xs font-bold text-[#0b315f] hover:underline">+ Agregar</button></div>
              {esTurismo&&<div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 mb-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-base">🗺️</span>
                    <p className="text-xs font-black text-amber-800">Programa del recorrido <span className="font-normal text-amber-600">— aparece como Pág. 2 en el PDF</span></p>
                  </div>
                  <button type="button" onClick={preLlenarItinerario} className="flex-shrink-0 text-xs font-bold text-amber-700 bg-amber-100 hover:bg-amber-200 px-3 py-1.5 rounded-lg border border-amber-300 transition-colors whitespace-nowrap">📋 Pre-llenar plantilla</button>
                </div>
                <textarea
                  rows={5}
                  className="w-full border border-amber-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100 resize-y min-h-[110px] leading-relaxed"
                  placeholder={`Ej:\n06:00 - Recojo en hotel\n08:00 - Llegada a Paracas\n...`}
                  value={form.itinerario_texto}
                  onChange={e=>{setForm(p=>({...p,itinerario_texto:e.target.value}));e.target.style.height="auto";e.target.style.height=e.target.scrollHeight+"px";}}
                  style={{overflow:"hidden"}}
                />
                {form.itinerario_texto.trim()&&<p className="text-[9px] text-amber-600">✓ Se generará Pág. 2 — ANEXO 1 (Programa Detallado) en el PDF</p>}
              </div>}
              <div className="hidden md:grid grid-cols-12 gap-2 px-2 mb-1">
                <div className="col-span-4 text-[9px] font-bold uppercase tracking-wide text-gray-400">Descripción</div>
                <div className="col-span-1 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-center">Días</div>
                <div className="col-span-1 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-center">Cant.</div>
                <div className="col-span-2 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-right">P. Unit.</div>
                <div className="col-span-1 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-center">Dto.%</div>
                <div className="col-span-2 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-right">Total</div>
                <div className="col-span-1"/>
              </div>
              <div className="space-y-2">
                {items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return(<div key={i} className="grid grid-cols-12 gap-2 items-start bg-gray-50 rounded-xl p-2"><div className="col-span-12 md:col-span-4"><textarea rows={1} className={iCls("resize-y min-h-[40px] leading-snug")} placeholder="Descripción del servicio" value={it.descripcion} onChange={e=>{updItem(i,"descripcion",e.target.value);e.target.style.height="auto";e.target.style.height=e.target.scrollHeight+"px";}} style={{overflow:"hidden"}}/></div><div className="col-span-3 md:col-span-1"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">Días</label><input type="number" min="1" className={iCls("text-center")} value={it.dias} onChange={e=>updItem(i,"dias",e.target.value)}/></div><div className="col-span-3 md:col-span-1"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">Cant.</label><input type="number" min="1" className={iCls("text-center")} value={it.cantidad} onChange={e=>updItem(i,"cantidad",e.target.value)}/></div><div className="col-span-6 md:col-span-2"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">P. Unit.</label><input type="number" min="0" className={iCls("text-right")} placeholder="0.00" value={it.precio_unit||""} onChange={e=>updItem(i,"precio_unit",e.target.value)}/></div><div className="col-span-3 md:col-span-1"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">Dto.%</label><input type="number" min="0" max="100" className={iCls("text-center")} placeholder="0" value={it.descuento_pct||""} onChange={e=>updItem(i,"descuento_pct",e.target.value)}/></div><div className="col-span-9 md:col-span-2 text-right font-bold text-sm text-gray-800 pr-2 flex md:block items-center justify-end gap-1"><span className="md:hidden text-[9px] font-normal text-gray-400">Total:</span>{fmtS(tf)}</div><div className="col-span-3 md:col-span-1 flex justify-end">{items.length>1&&<button onClick={()=>delItem(i)} className="w-7 h-7 rounded-lg text-red-400 hover:bg-red-50 font-bold text-sm">✕</button>}</div>{(flota.length>0||flotaTercero.length>0)&&<div className="col-span-12 mt-1"><select className="w-full border border-gray-100 rounded-lg px-2 py-1.5 text-xs text-gray-500 bg-white focus:outline-none focus:border-[#0b315f]" value={it.vehiculo_flota_id?`f_${it.vehiculo_flota_id}`:it.vehiculo_tercero_id?`t_${it.vehiculo_tercero_id}`:""} onChange={e=>{const val=e.target.value;setItems(prev=>prev.map((x,xi)=>xi!==i?x:val.startsWith("f_")?{...x,vehiculo_flota_id:Number(val.slice(2)),vehiculo_tercero_id:null}:val.startsWith("t_")?{...x,vehiculo_flota_id:null,vehiculo_tercero_id:Number(val.slice(2))}:{...x,vehiculo_flota_id:null,vehiculo_tercero_id:null}));}}><option value="">🚌 Asignar vehículo a este ítem (opcional)</option>{flota.length>0&&<optgroup label="Flota propia">{flota.map(v=><option key={v.id} value={`f_${v.id}`}>{v.placa}{v.categoria?` · ${v.categoria}`:""}{v.marca?` ${v.marca}`:""}{v.capacidad_pasajeros?` (${v.capacidad_pasajeros}p)`:""}</option>)}</optgroup>}{flotaTercero.length>0&&<optgroup label="Tercerizado">{flotaTercero.map(v=><option key={v.id} value={`t_${v.id}`}>{v.placa}{v.categoria?` · ${v.categoria}`:""}{v.empresa_nombre?` — ${v.empresa_nombre}`:""}</option>)}</optgroup>}</select></div>}</div>);})}
              </div>
              <div className="flex justify-end mt-4">
                <div className="w-full md:w-72 space-y-1.5 bg-gray-50 rounded-xl p-4">
                  {form.incluye_igv&&<>
                    <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal (sin IGV)</span><span className="font-bold">{fmtS(subtotal)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-500">IGV 18%</span><span className="font-bold">{fmtS(igv)}</span></div>
                  </>}
                  <div className="flex justify-between text-base border-t pt-2" style={{borderColor:"#0b315f"}}>
                    <span className="font-black">{esFijoForm?"Total/día":"Total"}</span>
                    <span className="font-black" style={{color:"#0b315f"}}>{fmtS(total)}</span>
                  </div>
                  {!form.incluye_igv&&<p className="text-[10px] text-amber-700 font-semibold text-right">No incluye IGV</p>}
                  {esFijoForm&&<div className="flex justify-between text-sm"><span className="text-gray-400">Mes est. (×26)</span><span className="font-black text-green-600">{fmtS(total*26)}</span></div>}
                </div>
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Consideraciones <span className="normal-case font-normal text-blue-500">→ aparecen en el PDF</span></p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {([{key:"incluye" as const,label:"✅ Servicio incluye",color:"#166534",bg:"#f0fdf4",border:"#86efac"},{key:"no_incluye" as const,label:"❌ No incluye",color:"#991b1b",bg:"#fff5f5",border:"#fca5a5"}]).map(({key,label,color,bg,border})=>(
                  <div key={key} className="rounded-xl border-2 p-3 space-y-2" style={{background:bg,borderColor:border}}><p className="text-xs font-black" style={{color}}>{label}</p><div className="space-y-1.5">{consid[key].map((item,i)=><div key={i} className="flex gap-2 items-center"><input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white" value={item} onChange={e=>setConsid(prev=>({...prev,[key]:prev[key].map((it,idx)=>idx===i?e.target.value:it)}))}/><button onClick={()=>setConsid(prev=>({...prev,[key]:prev[key].filter((_,idx)=>idx!==i)}))} className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button></div>)}</div><button onClick={()=>setConsid(prev=>({...prev,[key]:[...prev[key],""]}))  } className="text-[10px] font-bold hover:underline" style={{color}}>+ Agregar ítem</button></div>
                ))}
              </div>
              <div className="rounded-xl border-2 p-3 space-y-2 mt-4" style={{background:"#eef3f8",borderColor:"#93c5fd"}}>
                <p className="text-xs font-black text-[#0b315f]">📋 Consideraciones generales</p>
                <div className="space-y-1.5">{consid.generales.map((item,i)=><div key={i} className="flex gap-2 items-center"><input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white" value={item} onChange={e=>setConsid(prev=>({...prev,generales:prev.generales.map((it,idx)=>idx===i?e.target.value:it)}))}/><button onClick={()=>setConsid(prev=>({...prev,generales:prev.generales.filter((_,idx)=>idx!==i)}))} className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button></div>)}</div>
                <div className="flex items-center gap-4"><button onClick={()=>setConsid(prev=>({...prev,generales:[...prev.generales,""]}))} className="text-[10px] font-bold text-[#0b315f] hover:underline">+ Agregar ítem</button><button onClick={()=>setConsid(prev=>({...prev,generales:[...(cfgDefault?.condiciones_generales?.length?cfgDefault.condiciones_generales:DEFAULT_CONSID.generales)]}))} className="text-[10px] text-gray-400 hover:underline">↺ Restaurar por defecto</button></div>
              </div>
            </div>

            <div className={requiereParadas?"rounded-2xl border-2 p-4":""}  style={requiereParadas?{borderColor:paradas.length<2?"#fca5a5":"#86efac",background:paradas.length<2?"#fff5f5":"#f0fdf4"}:{}}>
              <div className="flex items-center gap-2 border-b pb-1 mb-3" style={requiereParadas?{borderColor:paradas.length<2?"#fca5a5":"#86efac"}:{}}>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{esFijoForm?"🚏 Paraderos":"📍 Puntos del recorrido"}</p>
                {requiereParadas&&(paradas.length<2
                  ?<span className="text-[9px] font-black text-red-600 bg-red-100 border border-red-300 px-2 py-0.5 rounded-full animate-pulse">REQUERIDO · {paradas.length}/2 mín.</span>
                  :<span className="text-[9px] font-black text-green-700 bg-green-100 border border-green-300 px-2 py-0.5 rounded-full">✓ {paradas.length} puntos</span>
                )}
              </div>
              <ParadasBuilder
                paradas={paradas} onChange={setParadas} tipo={form.tipo_servicio}
                mapsLoaded={mapsLoaded}
                origenNombre={form.origen} destinoNombre={form.destino}
                origenLat={origenPlace?.lat?String(origenPlace.lat):""} origenLng={origenPlace?.lng?String(origenPlace.lng):""}
                destinoLat={destinoPlace?.lat?String(destinoPlace.lat):""} destinoLng={destinoPlace?.lng?String(destinoPlace.lng):""}
                horaIda={form.hora_ida} horaRetorno={form.hora_retorno}
              />
            </div>

            {/* Paradas de retorno — solo para servicios fijos con retorno */}
            {esFijoForm&&!esSoloIda&&form.hora_retorno&&(
              <div className="rounded-2xl border-2 p-4" style={{borderColor:paradasRetorno.length<2?"#c4b5fd":"#a5b4fc",background:paradasRetorno.length<2?"#f5f3ff":"#eef2ff"}}>
                <div className="flex items-center gap-2 border-b pb-1 mb-3" style={{borderColor:paradasRetorno.length<2?"#c4b5fd":"#a5b4fc"}}>
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={{color:"#5b21b6"}}>↩ Paraderos del RETORNO</p>
                  {paradasRetorno.length<2
                    ?<span className="text-[9px] font-black px-2 py-0.5 rounded-full" style={{background:"#ddd6fe",color:"#5b21b6"}}>Opcional · {paradasRetorno.length} puntos</span>
                    :<span className="text-[9px] font-black px-2 py-0.5 rounded-full" style={{background:"#a5b4fc",color:"#1e1b4b"}}>✓ {paradasRetorno.length} puntos</span>
                  }
                  <span className="text-[9px] text-gray-400 ml-auto">Salida: {form.hora_retorno}</span>
                </div>
                <p className="text-[10px] text-gray-500 mb-3">Define los puntos del trayecto de regreso. Las paradas pueden diferir de la IDA (calzadas, dirección de vía, lat/lng distintas).</p>
                <ParadasBuilder
                  paradas={paradasRetorno} onChange={setParadasRetorno} tipo={form.tipo_servicio}
                  mapsLoaded={mapsLoaded}
                  origenNombre={form.destino} destinoNombre={form.origen}
                  origenLat={destinoPlace?.lat?String(destinoPlace.lat):""} origenLng={destinoPlace?.lng?String(destinoPlace.lng):""}
                  destinoLat={origenPlace?.lat?String(origenPlace.lat):""} destinoLng={origenPlace?.lng?String(origenPlace.lng):""}
                  horaIda={form.hora_retorno} horaRetorno=""
                />
              </div>
            )}

            {form.tipo_vehiculo&&form.tipo_servicio&&form.origen&&form.destino&&<div className="rounded-xl border px-4 py-3 flex items-start gap-3" style={{background:"#f0fdf4",borderColor:"#86efac"}}><input type="checkbox" id="chk_tar" checked={guardarTar} onChange={e=>setGuardarTar(e.target.checked)} className="w-4 h-4 mt-0.5 accent-green-600 flex-shrink-0"/><label htmlFor="chk_tar" className="cursor-pointer text-xs text-green-800"><b>Guardar en Tarifario</b> — {form.origen}→{form.destino} · {paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo)?.nombre||form.tipo_vehiculo} · {form.modo_servicio.toUpperCase()}</label></div>}

            <div className="flex gap-3 flex-wrap items-center pt-2 border-t">
              <button onClick={guardarCotizacion} disabled={guardando||calculandoKm} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 flex items-center gap-2" style={{background:"#0b315f"}}>
                {guardando?"⏳ Guardando...":calculandoKm?"⏳ Calculando km...":editandoId&&form.estado!=="borrador"?"✅ Actualizar cotización":"✅ Guardar cotización"}
              </button>
              <button onClick={guardarBorrador} disabled={guardando||calculandoKm} className="px-6 py-2.5 rounded-xl font-bold text-sm border-2 border-dashed border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-60 flex items-center gap-2">
                💾 {editandoId&&form.estado==="borrador"?"Actualizar borrador":"Guardar borrador"}
              </button>
              <button onClick={limpiar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-400 hover:bg-gray-50 ml-auto">✕ Cancelar</button>
            </div>
          </section>
        )}

        <section className="space-y-2 md:space-y-0 md:flex md:flex-row md:gap-3">
          <div className="flex gap-2 flex-1">
            <div className="relative flex-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span><input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none" placeholder="Buscar cliente, ruta o N°..." value={busqueda} onChange={e=>setBusqueda(e.target.value)}/></div>
            <div className="flex items-center px-3 py-2 bg-gray-50 border rounded-xl text-xs text-gray-400 whitespace-nowrap">{filtradas.length}</div>
          </div>
          <div className="grid grid-cols-2 md:flex gap-2">
            <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroModo} onChange={e=>setFiltroModo(e.target.value)}><option value="todos">Eventual + Fijo</option><option value="eventual">Solo Eventual</option><option value="fijo">Solo Fijo</option></select>
            <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroEst} onChange={e=>setFiltroEst(e.target.value)}><option value="todos">Todos estados</option><option value="borrador">Borradores</option><option value="pendiente">Pendientes</option><option value="enviado">Enviadas</option><option value="aprobado">Aprobadas</option><option value="rechazado">Rechazadas</option></select>
          </div>
        </section>

        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">

          {/* ── Vista cards (móvil/tablet) ── */}
          <div className="md:hidden divide-y divide-gray-100">
            {loading
              ? <div className="p-10 text-center text-gray-400"><div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>Cargando...</div></div>
              : filtradas.length===0
                ? <div className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">📄</p><p>No hay cotizaciones</p></div>
                : filtradas.map(c=>{
                    const esBorrador=c.estado==="borrador";const est=ESTADO_CFG[c.estado]||ESTADO_CFG.pendiente;const margen=Number(c.margen_estimado||0);const esFijo=c.modo_servicio==="fijo";const tieneDsc=c.descuento_solicitado&&!c.descuento_autorizado;const tieneDec=!!(c.precio_cotizador||c.precio_tarifario);
                    return(
                      <div key={c.id} className={`p-4 space-y-2.5 ${esBorrador?"opacity-70":""} ${tieneDsc?"bg-orange-50":""}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono font-black text-[#0b315f] text-sm">#{c.numero_cotizacion||String(c.id).padStart(5,"0")}</span>
                            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${esFijo?"bg-green-100 text-green-700":"bg-blue-100 text-blue-700"}`}>{esFijo?"📅 FIJO":"📋 EVEN."}</span>
                            {tieneDsc&&<span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 animate-pulse">🙋 Dscto.</span>}
                          </div>
                          <select value={c.estado} onChange={e=>cambiarEstado(c,e.target.value as EstadoCot)} className="text-[10px] font-bold px-2 py-1 rounded-lg border-0 cursor-pointer flex-shrink-0" style={{background:est.bg,color:est.color}}>
                            {(["borrador","pendiente","enviado","aprobado","rechazado"] as EstadoCot[]).map(s=>(
                              <option key={s} value={s} disabled={s!==c.estado&&!TRANSICIONES[c.estado].includes(s)}>{s===c.estado?"✓ ":TRANSICIONES[c.estado].includes(s)?"→ ":"✕ "}{ESTADO_CFG[s].label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="font-bold text-gray-800 text-sm">{nomCl(c.cliente_id)}{c.atencion&&<span className="font-normal text-gray-400 text-xs"> · {c.atencion}</span>}</div>
                        <div className="text-xs text-gray-500 truncate">{c.origen} → {c.destino}{c.asunto&&<span className="text-gray-400"> · {c.asunto}</span>}</div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-gray-800">{fmtS(Number(c.precio_cliente||0))}</span>
                            {esFijo&&<span className="text-[10px] text-gray-400">/día</span>}
                            <span className="text-xs font-bold" style={{color:margen>=0?"#166534":"#991b1b"}}>{fmtS(margen)}</span>
                          </div>
                          <span className="text-xs text-gray-400">{fmtF(c.fecha_servicio)}</span>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={()=>editarCot(c)} className="flex-1 py-2 rounded-xl text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️ Editar</button>
                          <button onClick={()=>duplicarCotizacion(c)} className="py-2 px-3 rounded-xl text-xs font-bold border hover:bg-purple-50" style={{color:"#7c3aed",borderColor:"#ddd6fe"}} title="Duplicar cotización">📋</button>
                          <button onClick={()=>{setModalPlantilla(c);setPlantillaElegida(c.plantilla_pdf||"corporativo");}} className="flex-1 py-2 rounded-xl text-xs font-bold border" style={{background:"#eef3f8",color:"#0b315f"}}>📄 PDF</button>
                          <button onClick={()=>convertirAReserva(c)} disabled={c.estado!=="aprobado"} className="flex-1 py-2 rounded-xl text-xs font-bold border disabled:opacity-30" style={{background:"#dcfce7",color:"#166534"}}>→ Res.</button>
                          {rolUsuario==="admin"&&<button onClick={()=>setModalEliminar(c)} className="py-2 px-3 rounded-xl text-xs font-bold border hover:bg-red-50" style={{color:"#dc2626",borderColor:"#fca5a5"}} title="Eliminar cotización">🗑️</button>}
                        </div>
                        {tieneDec&&<button onClick={()=>setPanelId(panelId===c.id?null:c.id)} className={`text-[10px] font-black px-2 py-1 rounded-full ${tieneDsc?"bg-orange-100 text-orange-700":"bg-[#eef3f8] text-[#0b315f]"}`}>{tieneDsc?"🙋 Descuento pendiente":"💡 Ver precios"}</button>}
                        {panelId===c.id&&<PanelDecision c={c} onAct={cargar}/>}
                      </div>
                    );
                  })
            }
          </div>

          {/* ── Vista tabla (desktop) ── */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0"}}>{["N°","Cliente","Ruta","Vehículo","Servicio","Fecha","Precio","Margen","Estado","Acciones"].map(h=><th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {loading?<tr><td colSpan={10} className="p-10 text-center text-gray-400"><div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>Cargando...</div></td></tr>:filtradas.length===0?<tr><td colSpan={10} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">📄</p><p>No hay cotizaciones</p></td></tr>:filtradas.map(c=>{
                  const esBorrador=c.estado==="borrador";const est=ESTADO_CFG[c.estado]||ESTADO_CFG.pendiente;const margen=Number(c.margen_estimado||0);const vehParam=paramsDB.find(p=>p.tipo_vehiculo===c.tipo_vehiculo);const vehF=flota.find(v=>v.id===c.vehiculo_flota_id);const vehT=flotaTercero.find(v=>v.id===c.vehiculo_tercero_id);
                  const tieneDec=!!(c.precio_cotizador||c.precio_tarifario);const tieneDsc=c.descuento_solicitado&&!c.descuento_autorizado;const esFijo=c.modo_servicio==="fijo";const servLabel=[...SERVS_EVENTUAL,...SERVS_FIJO].find(s=>s.id===c.tipo_servicio)?.label||c.tipo_servicio||"";
                  return(<React.Fragment key={c.id}>
                    <tr className={`border-t hover:bg-gray-50 ${esBorrador?"opacity-70 italic":""}${tieneDsc?" bg-orange-50":""}`} style={{borderColor:"#f1f5f9"}}>
                      <td className="p-3 font-mono font-black text-[#0b315f] text-xs"><div>#{c.numero_cotizacion||String(c.id).padStart(5,"0")}</div><div className={`text-[9px] font-black px-1.5 py-0.5 rounded-full mt-0.5 inline-block ${esFijo?"bg-green-100 text-green-700":"bg-blue-100 text-blue-700"}`}>{esFijo?"📅 FIJO":"📋 EVENTUAL"}</div>{tieneDec&&<button onClick={()=>setPanelId(panelId===c.id?null:c.id)} className={`block mt-1 text-[9px] font-black px-1.5 py-0.5 rounded-full ${tieneDsc?"bg-orange-100 text-orange-700 animate-pulse":"bg-[#eef3f8] text-[#0b315f] hover:bg-blue-100"}`}>{tieneDsc?"🙋 Descuento":"💡 Precios"}</button>}</td>
                      <td className="p-3 max-w-[120px]"><div className="font-bold text-gray-800 truncate">{nomCl(c.cliente_id)}</div>{c.atencion&&<div className="text-xs text-gray-400 truncate">{c.atencion}</div>}</td>
                      <td className="p-3 max-w-[150px]"><div className="truncate text-gray-700 text-xs">{c.origen}→{c.destino}</div>{c.asunto&&<div className="text-[10px] text-gray-400 truncate">{c.asunto}</div>}</td>
                      <td className="p-3">{vehF?<p className="font-mono font-black text-xs text-[#0b315f]">{vehF.placa}</p>:vehT?<div><p className="font-mono font-black text-xs text-amber-700">{vehT.placa}</p><p className="text-[9px] text-amber-600">🤝 {vehT.empresa_nombre}</p></div>:vehParam?<div className="text-xs text-gray-500">{vehParam.icono||"🚌"} {vehParam.nombre}</div>:<span className="text-gray-300 text-xs">—</span>}</td>
                      <td className="p-3"><span className="text-[10px] font-bold text-gray-600">{servLabel}</span>{c.paradas_json&&c.paradas_json.length>0&&<span className="text-[10px] text-[#be185d] font-bold block">🚏 {c.paradas_json.length} paradas</span>}</td>
                      <td className="p-3 text-xs text-gray-500">{fmtF(c.fecha_servicio)}{c.hora_ida&&<div className="text-gray-400">{c.hora_ida}</div>}</td>
                      <td className="p-3 font-bold text-gray-800">{fmtS(Number(c.precio_cliente||0))}{esFijo&&<p className="text-[10px] text-gray-400 font-normal">/día</p>}{esFijo&&c.precio_mes_estimado&&<p className="text-[10px] text-green-600 font-bold">~{fmtS(c.precio_mes_estimado)}/mes</p>}</td>
                      <td className="p-3 font-bold" style={{color:margen>=0?"#166534":"#991b1b"}}>{fmtS(margen)}</td>
                      <td className="p-3" onClick={e=>e.stopPropagation()}>
                        <select value={c.estado} onChange={e=>cambiarEstado(c,e.target.value as EstadoCot)} className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer" style={{background:est.bg,color:est.color}}>
                          {(["borrador","pendiente","enviado","aprobado","rechazado"] as EstadoCot[]).map(s=>(
                            <option key={s} value={s} disabled={s!==c.estado&&!TRANSICIONES[c.estado].includes(s)}>
                              {s===c.estado?"✓ ":TRANSICIONES[c.estado].includes(s)?"→ ":"✕ "}{ESTADO_CFG[s].label}
                            </option>
                          ))}
                        </select>
                        {c.estado==="enviado"&&c.medio_envio&&<p className="text-[9px] text-gray-400 mt-0.5 font-medium">{c.medio_envio==="WhatsApp"?"💬":c.medio_envio.startsWith("Correo")?"✉️":"📋"} {c.medio_envio}</p>}
                      </td>
                      <td className="p-3"><div className="flex gap-1 flex-wrap"><button onClick={()=>editarCot(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button><button onClick={()=>duplicarCotizacion(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-purple-50" style={{color:"#7c3aed",borderColor:"#ddd6fe"}} title="Duplicar cotización">📋</button><button onClick={()=>{setModalPlantilla(c);setPlantillaElegida(c.plantilla_pdf||"corporativo");}} className="px-2 py-1.5 rounded-lg text-xs font-bold border" style={{background:"#eef3f8",color:"#0b315f"}}>📄 PDF</button><button onClick={()=>convertirAReserva(c)} disabled={c.estado!=="aprobado"} className="px-2 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-30" style={{background:"#dcfce7",color:"#166534"}}>→Res</button>{rolUsuario==="admin"&&<button onClick={()=>setModalEliminar(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-red-50" style={{color:"#dc2626",borderColor:"#fca5a5"}} title="Eliminar cotización">🗑️</button>}</div></td>
                    </tr>
                    {panelId===c.id&&<tr><td colSpan={10} className="px-4 pb-3 pt-0"><PanelDecision c={c} onAct={cargar}/></td></tr>}
                  </React.Fragment>);
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between flex-wrap gap-1"><span>{filtradas.length} de {totC} cotizaciones · {paramsDB.length} vehículos</span><span className="hidden sm:inline">AFA ERP · Comercial</span></div>
        </section>
      </main>
    </>
  );
}