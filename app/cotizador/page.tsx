"use client";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// ══════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════

type ParamCosto = {
  tipo_vehiculo:string; nombre:string; capacidad:number;
  icono:string|null; grupo_vehiculo:string|null;
  euronorm:string|null; usa_urea:boolean; consumo_urea_pct:number|null;
  tipo_combustible_1:string; rendimiento_1:number; pct_uso_1:number;
  tipo_combustible_2:string|null; rendimiento_2:number|null; pct_uso_2:number|null;
  n_neumaticos:number; costo_neumatico:number; vida_neumatico_km:number;
  mantenimiento_km:number; valor_compra:number; residual_pct:number;
  vida_util_anios:number; km_anio:number;
  seguro_anual:number; soat_anual:number; revision_semestral:number;
  permisos_anual:number; otros_fijos_mensual:number; conductor_dia:number;
};

type Resultado = {
  costoCombustible:number; costoNeumaticos:number; costoMantenimiento:number;
  costoDeprec:number; costoFijosKm:number; costoUrea:number;
  reserva:number; costoVehiculo:number; costoConductor:number;
  costoDirectos:number; costoDirectoTotal:number; overhead:number;
  baseCosto:number; costoKm:number;
  totalMin15:number; totalEst20:number; totalAlto25:number;
  sinIGV15:number; sinIGV20:number; sinIGV25:number; precioPax20:number;
  diaEst:number; diaEstIGV:number; diaMinIGV:number; diaAltoIGV:number;
  mesEstIGV:number;
};

type PlaceResult = { address:string; lat:number; lng:number; placeId:string; };

type Punto = {
  id:string;
  tipo:"inicio"|"parada"|"destino";
  texto:string;
  place:PlaceResult|null;
};

type Segmento = { km:number; duracion:string; loading:boolean; error:string; };

type DiaPlan = {
  id:string; numero:number;
  puntos:Punto[];
  segmentos:Segmento[];
  pernocte:number; viaticos:number;
};

// ══════════════════════════════════════════════════════════════════
// MOTOR DE CÁLCULO
// ══════════════════════════════════════════════════════════════════

const IGV=0.18, OVERHEAD=0.10, RESERVA=0.05;

function calcular(p:ParamCosto, pr:Record<string,number>, km:number, dias:number, peajes:number, otros:number, pernocte:number, viaticos:number):Resultado|null {
  if(!p||km<=0)return null;
  const pc1=pr[p.tipo_combustible_1]||0;
  const combKm=(pc1/p.rendimiento_1)*p.pct_uso_1+(p.tipo_combustible_2&&p.rendimiento_2&&p.pct_uso_2?((pr[p.tipo_combustible_2]||0)/p.rendimiento_2)*p.pct_uso_2:0);
  const ureaRate=p.usa_urea&&p.tipo_combustible_1==="Diésel"?(1/p.rendimiento_1)*3.785*(p.consumo_urea_pct||0.04)*(pr["UREA"]||0):0;
  const costoCombustible=(combKm+ureaRate)*km; const costoUrea=ureaRate*km;
  const costoNeumaticos=((p.n_neumaticos*p.costo_neumatico)/p.vida_neumatico_km)*km;
  const costoMantenimiento=p.mantenimiento_km*km;
  const costoDeprec=((p.valor_compra*(1-p.residual_pct))/(p.vida_util_anios*p.km_anio))*km;
  const costoFijosKm=((p.seguro_anual+p.soat_anual+p.revision_semestral*2+p.permisos_anual+p.otros_fijos_mensual*12)/p.km_anio)*km;
  const sub=costoCombustible+costoNeumaticos+costoMantenimiento+costoDeprec+costoFijosKm;
  const reserva=sub*RESERVA; const costoVehiculo=sub+reserva;
  const costoConductor=p.conductor_dia*dias;
  const costoDirectos=peajes+otros;
  const costoDirectoTotal=costoVehiculo+costoConductor+costoDirectos;
  const overhead=costoDirectoTotal*OVERHEAD;
  const baseCosto=costoDirectoTotal+overhead+pernocte+viaticos;
  const costoKm=costoDirectoTotal/Math.max(km,1);
  const pF=(m:number)=>baseCosto/(1-m); const fF=(m:number)=>pF(m)*(1+IGV);
  return{costoCombustible,costoNeumaticos,costoMantenimiento,costoDeprec,costoFijosKm,costoUrea,reserva,costoVehiculo,costoConductor,costoDirectos,costoDirectoTotal,overhead,baseCosto,costoKm,totalMin15:fF(0.15),totalEst20:fF(0.20),totalAlto25:fF(0.25),sinIGV15:pF(0.15),sinIGV20:pF(0.20),sinIGV25:pF(0.25),precioPax20:fF(0.20)/(p.capacidad||1),diaEst:pF(0.20),diaEstIGV:fF(0.20),diaMinIGV:fF(0.15),diaAltoIGV:fF(0.25),mesEstIGV:fF(0.20)*26};
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════

const fmt  = (n:number)=>`S/ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtN = (n:number,d=0)=>n.toLocaleString("es-PE",{minimumFractionDigits:d,maximumFractionDigits:d});
const uid  = ()=>Math.random().toString(36).slice(2,8);
const enHorario=()=>{const l=new Date(new Date().toLocaleString("en-US",{timeZone:"America/Lima"}));return l.getDay()>=1&&l.getDay()<=5&&l.getHours()>=8&&l.getHours()<18;};
const COMB_COLOR:Record<string,string>={Gasolina:"#f97316",Diésel:"#0b315f",GLP:"#8b5cf6",GNV:"#10b981",UREA:"#06b6d4"};
const GRUPO_CFG:Record<string,{color:string;bg:string}>={Ligeros:{color:"#6366f1",bg:"#eef2ff"},Vans:{color:"#0891b2",bg:"#ecfeff"},Buses:{color:"#0b315f",bg:"#eef3f8"},Otros:{color:"#6b7280",bg:"#f3f4f6"}};

const PUNTO_VACIO = (tipo:"inicio"|"parada"|"destino"="parada"):Punto => ({id:uid(),tipo,texto:"",place:null});

// El place elegido en Places solo vale mientras el texto visible siga siendo el
// que devolvió Google. Si el usuario edita o pega encima sin elegir sugerencia,
// el place (y su placeId) seguiría apuntando al destino ANTERIOR: la clave del
// tramo no cambiaría, no habría recálculo y se cotizaría el km de un destino
// distinto al que se ve en pantalla. Al invalidarlo, el km queda "sin calcular".
const placeVigente = (texto:string, place:PlaceResult|null):PlaceResult|null =>
  place && texto.trim()===place.address.trim() ? place : null;

function minutosTotales(duraciones:string[]):string {
  let mins=0;
  duraciones.forEach(d=>{
    const h=d.match(/(\d+)\s*h/);const m=d.match(/(\d+)\s*min/);
    if(h)mins+=parseInt(h[1])*60;if(m)mins+=parseInt(m[1]);
  });
  if(mins===0)return"";
  const h=Math.floor(mins/60);const m=mins%60;
  return h>0?`${h}h ${m>0?m+"min":""}`:`${m}min`;
}

// ══════════════════════════════════════════════════════════════════
// HOOKS: GOOGLE MAPS
// ══════════════════════════════════════════════════════════════════

function useGoogleMaps(){
  const[loaded,setLoaded]=useState(false);
  useEffect(()=>{
    if(typeof window==="undefined")return;
    if((window as any).google?.maps?.places){setLoaded(true);return;}
    const ex=document.getElementById("gmaps-script");
    if(ex){ex.addEventListener("load",()=>setLoaded(true));return;}
    const s=document.createElement("script");
    s.id="gmaps-script";
    s.src=`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&language=es&region=PE`;
    s.async=true;s.defer=true;s.onload=()=>setLoaded(true);
    document.head.appendChild(s);
  },[]);
  return loaded;
}

// Distance Matrix se factura POR ELEMENTO (orígenes × destinos), así que
// memorizamos cada par ya consultado. Al tocar un punto solo se piden los
// tramos realmente nuevos, no el itinerario entero. Vive a nivel de módulo
// para que los pares repetidos (minas, plantas, hoteles) sirvan entre
// cotizaciones distintas sin volver a facturar.
const cacheTramos = new Map<string,{km:number;duracion:string}>();
// La clave es SIEMPRE el placeId, porque es lo que se le pide a Google. Dos
// accesos distintos del mismo edificio caen en la misma coordenada redondeada
// (~1 m) pero son destinos diferentes: con coordenadas solas se serviría el km
// del otro. La rama de coordenadas hoy NO se alcanza —los dos hooks descartan
// los puntos sin placeId— y queda solo como defensa por si en el futuro entra
// un punto que no venga de Places.
const clavePunto = (p:PlaceResult)=>p.placeId||`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
const claveTramo = (o:PlaceResult,d:PlaceResult)=>`${clavePunto(o)}>${clavePunto(d)}`;

// Hook para calcular distancia entre múltiples puntos consecutivos
function useMultiSegmentos(places:(PlaceResult|null)[], mapsLoaded:boolean):{segmentos:Segmento[];kmTotal:number;durTotal:string;cargando:boolean;conError:boolean} {
  const [segmentos,setSegmentos]=useState<Segmento[]>([]);
  const pts=places.filter(p=>!!p?.placeId) as PlaceResult[];
  const key=pts.map(clavePunto).join("|");

  useEffect(()=>{
    // `cancelado` invalida esta consulta cuando la ruta cambia antes de que
    // Google responda: una respuesta tardía del destino ANTERIOR no puede pisar
    // el km del destino ACTUAL (sería un kilometraje equivocado en el precio).
    let cancelado=false;
    const limpiar=()=>{cancelado=true;};
    if(!mapsLoaded)return limpiar;
    if(pts.length<2){setSegmentos([]);return limpiar;}

    const n=pts.length-1;
    // Los tramos ya conocidos salen del caché; solo quedan en "loading" los nuevos.
    const result:Segmento[]=Array(n).fill(null).map((_,i)=>{
      const hit=cacheTramos.get(claveTramo(pts[i],pts[i+1]));
      return hit
        ?{km:hit.km,duracion:hit.duracion,loading:false,error:""}
        :{km:0,duracion:"",loading:true,error:""};
    });
    setSegmentos([...result]);

    const pendientes=result.filter(s=>s.loading).length;
    if(pendientes===0)return limpiar;

    const service=new google.maps.DistanceMatrixService();
    let done=0;

    for(let i=0;i<n;i++){
      if(!result[i].loading)continue;
      const idx=i;
      service.getDistanceMatrix({
        origins:[{placeId:pts[i].placeId}],
        destinations:[{placeId:pts[i+1].placeId}],
        travelMode:google.maps.TravelMode.DRIVING,
        unitSystem:google.maps.UnitSystem.METRIC,
      },(resp,status)=>{
        const el=resp?.rows[0]?.elements[0];
        if(el?.status==="OK"){
          const dato={km:Math.round(el.distance.value/1000),duracion:el.duration.text};
          // El tramo se guarda en caché aunque la consulta ya esté obsoleta: la
          // petición se facturó igual y el dato sirve para la siguiente ruta.
          cacheTramos.set(claveTramo(pts[idx],pts[idx+1]),dato);
          result[idx]={...dato,loading:false,error:""};
        }else{
          result[idx]={km:0,duracion:"",loading:false,error:"Sin ruta"};
        }
        done++;
        if(!cancelado&&done===pendientes)setSegmentos([...result]);
      });
    }
    return limpiar;
  },[key,mapsLoaded]);

  const kmTotal=segmentos.reduce((s,g)=>s+(g?.km||0),0);
  // Tres estados distintos, no dos: CARGANDO (con caché el arreglo ya trae
  // tramos resueltos mientras otros siguen en curso), ERROR (un tramo terminó
  // sin ruta y aporta 0 km) y LISTO. En los dos primeros `kmTotal` es una SUMA
  // INCOMPLETA —menor que la real— y abarataría la cotización, así que quien
  // consuma el km no debe propagarlo hasta que `cargando` y `conError` sean
  // false.
  //
  // El error se detecta SOLO por `error`, nunca por `km<=0`: un tramo de menos
  // de 500 m redondea a 0 km (Math.round sobre metros/1000, arriba) y es un
  // resultado PERFECTAMENTE VÁLIDO. Tratarlo como fallo bloquearía cotizar
  // cualquier itinerario con dos puntos cercanos —un hotel y su playa de
  // estacionamiento, por ejemplo—. Los tramos que sí fallan ya se marcan con
  // error:"Sin ruta" en el callback de arriba.
  const cargando=segmentos.some(s=>s?.loading);
  const conError=segmentos.some(s=>s&&!s.loading&&!!s.error);
  const durTotal=minutosTotales(segmentos.filter(s=>s&&!s.loading&&s.duracion).map(s=>s.duracion));
  return{segmentos,kmTotal,durTotal,cargando,conError};
}

// Hook para un solo segmento (retorno directo)
function useSegmento(origen:PlaceResult|null, destino:PlaceResult|null, mapsLoaded:boolean):Segmento {
  const [seg,setSeg]=useState<Segmento>({km:0,duracion:"",loading:false,error:""});
  const kOrigen=origen?.placeId?clavePunto(origen):"";
  const kDestino=destino?.placeId?clavePunto(destino):"";
  useEffect(()=>{
    // Igual que en useMultiSegmentos: si el par origen-destino cambia antes de
    // que Google responda, la respuesta vieja no debe escribir el estado.
    let cancelado=false;
    const limpiar=()=>{cancelado=true;};
    if(!mapsLoaded||!kOrigen||!kDestino){setSeg({km:0,duracion:"",loading:false,error:""});return limpiar;}
    const clave=`${kOrigen}>${kDestino}`;
    const hit=cacheTramos.get(clave);
    if(hit){setSeg({km:hit.km,duracion:hit.duracion,loading:false,error:""});return limpiar;}
    setSeg(s=>({...s,loading:true}));
    const service=new google.maps.DistanceMatrixService();
    service.getDistanceMatrix({
      origins:[{placeId:origen!.placeId}],destinations:[{placeId:destino!.placeId}],
      travelMode:google.maps.TravelMode.DRIVING,unitSystem:google.maps.UnitSystem.METRIC,
    },(resp,status)=>{
      const el=resp?.rows[0]?.elements[0];
      if(el?.status==="OK"){
        const dato={km:Math.round(el.distance.value/1000),duracion:el.duration.text};
        cacheTramos.set(clave,dato); // se cachea aunque esté obsoleto: ya se pagó
        if(!cancelado)setSeg({...dato,loading:false,error:""});
      }else if(!cancelado)setSeg({km:0,duracion:"",loading:false,error:"Sin ruta"});
    });
    return limpiar;
  },[kOrigen,kDestino,mapsLoaded]);
  return seg;
}

// ══════════════════════════════════════════════════════════════════
// COMPONENTE: PLACES INPUT
// ══════════════════════════════════════════════════════════════════

function PlacesInput({placeholder,value,onChange,onSelect,mapsLoaded,disabled=false,size="md"}:{
  placeholder:string;value:string;
  onChange:(v:string)=>void;onSelect:(r:PlaceResult)=>void;
  mapsLoaded:boolean;disabled?:boolean;size?:"sm"|"md";
}){
  const inputRef=useRef<HTMLInputElement>(null);
  const acRef=useRef<google.maps.places.Autocomplete|null>(null);
  const cls=size==="sm"
    ?"w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-[#0b315f] pr-6"
    :"w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f] focus:ring-2 focus:ring-[#0b315f]/20 pr-8";

  useEffect(()=>{
    if(!mapsLoaded||!inputRef.current||acRef.current)return;
    acRef.current=new google.maps.places.Autocomplete(inputRef.current,{
      componentRestrictions:{country:"pe"},
      // `fields` acotado a lo que se usa: el widget factura el getPlace() según
      // las categorías de datos pedidas, y pedir de más (contacto, atmosphere)
      // sube el costo. No se pasa sessionToken: el widget legacy no lo acepta
      // (no existe en AutocompleteOptions) y ya agrupa su propia sesión.
      fields:["formatted_address","geometry","place_id","name"],
      types:["geocode","establishment"],
    });
    acRef.current.addListener("place_changed",()=>{
      const p=acRef.current!.getPlace();
      if(!p.geometry?.location)return;
      const pName=p.name||"";
      const pAddr=p.formatted_address||"";
      const address=pName&&pAddr&&!pAddr.toLowerCase().includes(pName.toLowerCase())?`${pName}, ${pAddr}`:pAddr||pName;
      onChange(address);
      onSelect({address,lat:p.geometry.location.lat(),lng:p.geometry.location.lng(),placeId:p.place_id||""});
    });
  },[mapsLoaded]);

  return(
    <div className="relative">
      <input ref={inputRef} type="text" value={value} disabled={disabled}
        onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        className={cls+" bg-white"}/>
      {value&&!disabled&&(
        <button onClick={()=>{onChange("");onSelect({address:"",lat:0,lng:0,placeId:""});}}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 font-bold text-xs">✕</button>
      )}
      {!mapsLoaded&&<div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// COMPONENTE: BADGE DE TRAMO
// ══════════════════════════════════════════════════════════════════

function TramoInfo({seg}:{seg:Segmento}){
  if(seg.loading) return(
    <div className="flex items-center justify-center gap-1.5 py-1">
      <div className="w-3 h-3 border-2 border-gray-200 border-t-blue-500 rounded-full animate-spin"/>
      <span className="text-[10px] text-gray-400">Calculando...</span>
    </div>
  );
  // Solo `error` significa que Google no encontró ruta. Un tramo de 0 km es un
  // resultado válido (menos de 500 m, que redondea a 0) y debe pintarse como
  // tal, no como fallo.
  if(seg.error) return(
    <div className="text-center py-1"><span className="text-[10px] text-red-400">⚠ Sin ruta</span></div>
  );
  return(
    <div className="flex items-center justify-center gap-1.5 py-1">
      <div className="h-px flex-1 bg-gray-200"/>
      <span className="text-[10px] font-black text-[#0b315f] bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100">
        📏 {seg.km} km · ⏱ {seg.duracion}
      </span>
      <div className="h-px flex-1 bg-gray-200"/>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// RUTA SIMPLE — Solo Ida / Ida y Retorno
// ══════════════════════════════════════════════════════════════════

function RutaSimple({tipoServ,mapsLoaded,onUpdate}:{
  tipoServ:string; mapsLoaded:boolean;
  onUpdate:(km:number,origen:string,destino:string)=>void;
}){
  const esRetorno=tipoServ==="ida_retorno"||tipoServ==="transporte_personal";
  const [origenTxt,setOrigenTxt]=useState("");const [destinoTxt,setDestinoTxt]=useState("");
  const [origen,setOrigen]=useState<PlaceResult|null>(null);
  const [destino,setDestino]=useState<PlaceResult|null>(null);
  const [kmManual,setKmManual]=useState<number|null>(null);

  const seg=useSegmento(origen,destino,mapsLoaded);
  const kmAuto=seg.km>0?seg.km:0;
  const multiplicador=esRetorno?2:1;
  // Mientras el tramo se recalcula, `seg.km` todavía es el del destino anterior:
  // no se propaga al cotizador hasta que esté resuelto (0 = ruta sin calcular).
  const kmTotal=kmManual!==null?kmManual:(seg.loading?0:kmAuto*multiplicador);

  useEffect(()=>{onUpdate(kmTotal,origenTxt,destinoTxt);},[kmTotal,origenTxt,destinoTxt]);

  return(
    <div className="space-y-3">
      {/* Origen */}
      <div>
        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1">
          🟢 Origen
        </label>
        <PlacesInput placeholder="Ej: Plaza Norte, Lima" value={origenTxt} mapsLoaded={mapsLoaded}
          onChange={v=>{setOrigenTxt(v);if(origen&&!placeVigente(v,origen)){setOrigen(null);setKmManual(null);}}}
          onSelect={p=>{setOrigen(p.placeId?p:null);setKmManual(null);}}/>
      </div>

      {/* Tramo */}
      {origen?.placeId&&destino?.placeId&&<TramoInfo seg={seg}/>}
      {origen?.placeId&&!destino?.placeId&&<div className="flex items-center gap-2 py-1"><div className="flex-1 h-px border-t-2 border-dashed border-gray-200"/></div>}

      {/* Destino */}
      <div>
        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1">
          🔴 Destino final
        </label>
        <PlacesInput placeholder="Ej: Planta Cajamarquilla" value={destinoTxt} mapsLoaded={mapsLoaded}
          onChange={v=>{setDestinoTxt(v);if(destino&&!placeVigente(v,destino)){setDestino(null);setKmManual(null);}}}
          onSelect={p=>{setDestino(p.placeId?p:null);setKmManual(null);}}/>
      </div>

      {/* Resultado */}
      {kmAuto>0&&(
        <div className={`rounded-xl px-4 py-3 border ${esRetorno?"bg-blue-50 border-blue-200":"bg-green-50 border-green-200"}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-wide text-gray-500">
                {esRetorno?"Ida y retorno (×2)":"Solo ida (×1)"}
              </p>
              <p className="font-black text-2xl text-[#0b315f] mt-0.5">
                {kmManual!==null?kmManual:kmAuto*multiplicador} km
              </p>
              <p className="text-[10px] text-gray-500 mt-0.5">
                {esRetorno?(kmAuto+" km × 2 = "+kmAuto*2+" km · ⏱ "+seg.duracion+" por tramo"):("⏱ "+seg.duracion)}
                {kmManual!==null&&<span className="ml-1 text-amber-600 font-bold">· ✏️ ajustado</span>}
              </p>
            </div>
            {esRetorno&&<span className="text-3xl">⇄</span>}
          </div>
        </div>
      )}

      {/* Km manual */}
      <div>
        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
          Ajustar km manualmente
          {kmManual!==null&&<button onClick={()=>setKmManual(null)} className="ml-2 text-blue-500 hover:underline font-bold normal-case">↺ Usar Google Maps ({kmAuto*multiplicador} km)</button>}
        </label>
        <div className="flex items-center gap-2">
          <input type="number" min={1} placeholder={String(kmAuto*multiplicador||"0")} value={kmManual??""} onChange={e=>setKmManual(e.target.value?Number(e.target.value):null)}
            className={`flex-1 border rounded-xl px-3 py-2 text-sm font-mono font-bold outline-none text-center ${kmManual!==null?"border-amber-400 bg-amber-50 text-amber-700":"border-gray-200 text-gray-600 focus:border-[#0b315f]"}`}/>
          <span className="text-sm text-gray-400 font-bold">km</span>
        </div>
      </div>

      {/* Enlace Google Maps */}
      {origen?.placeId&&destino?.placeId&&(
        <a href={`https://www.google.com/maps/dir/?api=1&origin=place_id:${origen.placeId}&destination=place_id:${destino.placeId}&travelmode=driving`}
          target="_blank" rel="noreferrer"
          className="flex items-center justify-center gap-2 w-full py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-500 hover:bg-gray-50">
          🗺️ Ver ruta en Google Maps →
        </a>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// RUTA CON PARADAS — Disposición / Full Day / Multiparada fijo
// ══════════════════════════════════════════════════════════════════

function RutaConParadas({tipoServ,mapsLoaded,onUpdate}:{
  tipoServ:string; mapsLoaded:boolean;
  onUpdate:(km:number,puntos:Punto[])=>void;
}){
  const esFijMulti=tipoServ==="fijo_multiparada";
  const etiqueta=esFijMulti?"paradero":"parada";

  const [puntos,setPuntos]=useState<Punto[]>([
    PUNTO_VACIO("inicio"), PUNTO_VACIO("destino"),
  ]);
  const [retornaPorParadas,setRetornaPorParadas]=useState(false);
  const [retornaAlOrigen,setRetornaAlOrigen]=useState(false);
  const [kmManual,setKmManual]=useState<number|null>(null);

  // Places para el cálculo de tramos de ida
  const placesIda=puntos.map(p=>p.place);

  // Tramos de ida
  const {segmentos,kmTotal:kmIda,durTotal:durIda,cargando:cargandoIda,conError:errorIda}=useMultiSegmentos(placesIda,mapsLoaded);

  // Retorno directo (último→primero)
  const firstPlace=puntos[0]?.place||null;
  const lastPlace=puntos[puntos.length-1]?.place||null;
  const segRetornoDirecto=useSegmento(lastPlace,firstPlace,mapsLoaded);

  // KM retorno
  const kmRetorno=retornaAlOrigen
    ?(retornaPorParadas?kmIda:segRetornoDirecto.km)
    :0;

  const kmCalculado=kmIda+kmRetorno;
  // `kmIda` puede ser una suma PARCIAL: tramos cacheados listos + tramos nuevos
  // aún en cálculo (cargando), o tramos que fallaron y aportan 0 km (error). En
  // ambos casos el total es MENOR que el real, así que no se propaga al
  // cotizador: kmFinal=0 deja la cotización sin km y bloquea el guardado. El
  // fallo se muestra abajo en el resumen para que no sea un cero silencioso.
  const cargandoRuta=cargandoIda||(retornaAlOrigen&&!retornaPorParadas&&segRetornoDirecto.loading);
  // Igual que en useMultiSegmentos: el fallo se detecta por `error`, no por
  // `km<=0`. El estado inicial de useSegmento es {km:0,error:""}, así que mirar
  // el km pintaría el aviso rojo de «ruta con error» en un formulario todavía
  // vacío, antes de que el usuario elija ningún punto.
  const rutaConError=errorIda||(retornaAlOrigen&&!retornaPorParadas&&!segRetornoDirecto.loading&&!!segRetornoDirecto.error);
  // Un punto con texto pero sin place elegido de la lista NO se le pide a
  // Google (los hooks descartan lo que no trae placeId): el itinerario se
  // calcularía SALTÁNDOSE ese punto y daría menos km de los reales.
  const puntosSinPlace=puntos.some(p=>p.texto.trim()!==""&&!p.place);
  const rutaIncompleta=rutaConError||puntosSinPlace;
  const kmFinal=kmManual!==null?kmManual:(cargandoRuta||rutaIncompleta?0:kmCalculado);

  useEffect(()=>{onUpdate(kmFinal,puntos);},[kmFinal,JSON.stringify(puntos)]);

  const agregar=()=>{
    setPuntos(p=>{const n=[...p];n.splice(n.length-1,0,PUNTO_VACIO("parada"));return n;});
  };
  const eliminar=(id:string)=>setPuntos(p=>p.filter(x=>x.id!==id));
  const updPunto=(id:string,campo:Partial<Punto>)=>setPuntos(p=>p.map(x=>x.id===id?{...x,...campo}:x));

  const puntosConParadas=puntos.length>2;

  return(
    <div className="space-y-2">
      {puntos.map((punto,idx)=>{
        const esInicio=punto.tipo==="inicio";
        const esDestino=punto.tipo==="destino";
        const esIntermedia=punto.tipo==="parada";
        const seg=segmentos[idx];
        const color=esInicio?"#16a34a":esDestino?"#dc2626":"#0b315f";
        const icono=esInicio?"🟢":esDestino?"🔴":"📍";
        const label=esInicio?"Punto de inicio":esDestino?"Destino final":`${icono} ${etiqueta.charAt(0).toUpperCase()+etiqueta.slice(1)} ${idx}`;

        return(
          <div key={punto.id}>
            {/* Punto */}
            <div className="rounded-xl border-2 overflow-hidden" style={{borderColor:color+"44"}}>
              <div className="flex items-center gap-2 px-3 py-2" style={{background:color+"12"}}>
                <span className="text-base">{icono}</span>
                <span className="text-xs font-black flex-1" style={{color}}>{label}</span>
                {esIntermedia&&puntos.length>2&&(
                  <button onClick={()=>eliminar(punto.id)} className="text-gray-300 hover:text-red-500 font-bold text-sm">✕</button>
                )}
              </div>
              <div className="p-2">
                <PlacesInput size="sm"
                  placeholder={esInicio?"Dirección de inicio...":esDestino?"Dirección de destino final...":`Dirección del ${etiqueta}...`}
                  value={punto.texto} mapsLoaded={mapsLoaded}
                  onChange={v=>updPunto(punto.id,{texto:v,place:placeVigente(v,punto.place)})}
                  onSelect={p=>updPunto(punto.id,{texto:p.address,place:p.placeId?p:null})}/>
              </div>
            </div>

            {/* Tramo al siguiente */}
            {idx<puntos.length-1&&(
              <div className="px-4">
                {seg?<TramoInfo seg={seg}/>:<div className="flex items-center gap-2 py-1.5"><div className="flex-1 h-px border-t-2 border-dashed border-gray-100"/></div>}
              </div>
            )}
          </div>
        );
      })}

      {/* Botón agregar parada */}
      <button onClick={agregar}
        className="w-full py-2 rounded-xl border-2 border-dashed text-xs font-bold transition-colors hover:bg-blue-50"
        style={{borderColor:"#0b315f44",color:"#0b315f"}}>
        + Agregar {etiqueta}
      </button>

      {/* Opciones de retorno */}
      <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 space-y-2">
        <p className="text-[10px] font-black text-gray-500 uppercase tracking-wider">Opciones de retorno</p>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input type="checkbox" checked={retornaAlOrigen} onChange={e=>setRetornaAlOrigen(e.target.checked)}
            className="w-4 h-4 accent-[#0b315f] rounded"/>
          <div>
            <p className="text-xs font-bold text-gray-700">El vehículo regresa al punto de inicio</p>
            <p className="text-[10px] text-gray-400">Suma km del retorno al total</p>
          </div>
        </label>

        {retornaAlOrigen&&puntosConParadas&&(
          <div className="ml-6 space-y-1.5 border-l-2 border-gray-200 pl-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={!retornaPorParadas} onChange={()=>setRetornaPorParadas(false)}
                className="accent-[#0b315f]"/>
              <div>
                <p className="text-xs font-semibold text-gray-600">Retorno directo</p>
                <p className="text-[10px] text-gray-400">{"Destino → Origen sin paradas"+(segRetornoDirecto.km>0?" · "+segRetornoDirecto.km+" km":"")}</p>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={retornaPorParadas} onChange={()=>setRetornaPorParadas(true)}
                className="accent-[#0b315f]"/>
              <div>
                <p className="text-xs font-semibold text-gray-600">Retorno por las paradas</p>
                <p className="text-[10px] text-gray-400">Mismo recorrido en reversa · {kmIda} km</p>
              </div>
            </label>
          </div>
        )}

        {retornaAlOrigen&&!puntosConParadas&&segRetornoDirecto.km>0&&(
          <p className="text-[10px] text-blue-600 font-bold ml-6">Retorno directo: {segRetornoDirecto.km} km · {segRetornoDirecto.duracion}</p>
        )}
      </div>

      {/* Resumen — oculto mientras haya tramos en cálculo: pintar un total
          parcial junto al «Ingresa la ruta» del panel serían dos cifras
          contradictorias a la vez. Si algún tramo falló sí se muestra, pero
          marcado como incompleto y con el ajuste manual a la mano. */}
      {(kmIda>0||rutaIncompleta)&&!cargandoRuta&&(
        <div className="rounded-xl bg-[#eef3f8] border border-[#0b315f22] px-4 py-3">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2">Resumen de ruta</p>
          {rutaIncompleta&&(
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 mb-2">
              <p className="text-[10px] font-black text-red-600">{rutaConError?"⚠ Hay un tramo sin ruta":"⚠ Falta elegir una dirección de la lista"}</p>
              <p className="text-[10px] text-red-500 leading-snug">
                {rutaConError
                  ?"El total está incompleto y NO se usa en la cotización. Corrige la dirección del tramo marcado o ingresa el km manualmente."
                  :"Hay un punto escrito a mano: sin elegirlo de las sugerencias de Google no entra en el cálculo y el total quedaría corto. NO se usa en la cotización."}
              </p>
            </div>
          )}
          <div className="space-y-1">
            <div className="flex justify-between text-xs"><span className="text-gray-600">KM ida ({puntos.length-1} tramos)</span><span className="font-black text-[#0b315f]">{kmIda} km{rutaIncompleta?" (parcial)":""}</span></div>
            {retornaAlOrigen&&<div className="flex justify-between text-xs"><span className="text-gray-600">KM retorno {retornaPorParadas?"(por paradas)":"(directo)"}</span><span className="font-black text-[#0b315f]">{kmRetorno} km</span></div>}
            <div className="flex justify-between text-sm border-t border-[#0b315f22] pt-1.5 mt-1.5"><span className="font-black text-[#0b315f]">Total</span><span className={`font-black text-base ${kmManual===null&&rutaIncompleta?"text-red-500":"text-[#0b315f]"}`}>{kmManual!==null?`${kmManual} km`:(rutaIncompleta?"Incompleto":`${kmCalculado} km`)}</span></div>
            {durIda&&<p className="text-[10px] text-gray-400">⏱ Tiempo estimado ida: {durIda}</p>}
          </div>
          {/* Ajuste manual */}
          <div className="mt-3 flex items-center gap-2">
            <input type="number" min={1} placeholder={String(kmCalculado)} value={kmManual??""} onChange={e=>setKmManual(e.target.value?Number(e.target.value):null)}
              className={`flex-1 border rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold outline-none text-center ${kmManual!==null?"border-amber-400 bg-amber-50 text-amber-700":"border-gray-200 text-gray-600 focus:border-[#0b315f]"}`}/>
            <span className="text-xs text-gray-400">km manual</span>
            {kmManual!==null&&<button onClick={()=>setKmManual(null)} className="text-[10px] text-blue-500 hover:underline font-bold whitespace-nowrap">↺ Auto</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// RUTA MULTI-DÍA — itinerario independiente por día
// ══════════════════════════════════════════════════════════════════

function DiaPlanRow({dia,mapsLoaded,onChange,onEliminar,puedeEliminar}:{
  dia:DiaPlan; mapsLoaded:boolean;
  onChange:(d:DiaPlan)=>void; onEliminar:()=>void; puedeEliminar:boolean;
}){
  const places=dia.puntos.map(p=>p.place);
  const {segmentos,kmTotal,durTotal,cargando,conError}=useMultiSegmentos(places,mapsLoaded);

  // Sync km y segmentos al padre. `cargando` y `conError` van en las
  // dependencias para que el padre reciba el estado de los tramos aunque el km
  // total no haya cambiado (un tramo que falla deja el km igual, en 0).
  useEffect(()=>{onChange({...dia,segmentos,});},[kmTotal,cargando,conError]);

  // Punto escrito a mano (texto sin place): no se le pide a Google, así que el
  // día se calcularía saltándoselo y con menos km de los reales.
  const puntosSinPlace=dia.puntos.some(p=>p.texto.trim()!==""&&!p.place);
  const diaIncompleto=conError||puntosSinPlace;

  const updPunto=(id:string,campo:Partial<Punto>)=>onChange({
    ...dia,puntos:dia.puntos.map(p=>p.id===id?{...p,...campo}:p)
  });
  const agregar=()=>onChange({...dia,puntos:[...dia.puntos.slice(0,-1),PUNTO_VACIO("parada"),dia.puntos[dia.puntos.length-1]]});
  const eliminarPunto=(id:string)=>onChange({...dia,puntos:dia.puntos.filter(p=>p.id!==id)});

  return(
    <div className="rounded-2xl border-2 border-[#0b315f22] overflow-hidden">
      {/* Header del día */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#eef3f8] border-b border-[#0b315f22]">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-full bg-[#0b315f] text-white text-xs font-black flex items-center justify-center">{dia.numero}</span>
          <div>
            <p className="font-black text-[#0b315f] text-sm">Día {dia.numero}</p>
            {/* Nada de cifras mientras se calcula: sería un total parcial. */}
            {kmTotal>0&&!cargando&&<p className="text-[10px] text-gray-500">{kmTotal} km{diaIncompleto?" (incompleto)":""} · {durTotal}</p>}
          </div>
        </div>
        {puedeEliminar&&<button onClick={onEliminar} className="text-red-400 hover:text-red-600 text-xs font-bold border border-red-200 hover:bg-red-50 px-2 py-1 rounded-lg">✕ Eliminar día</button>}
      </div>

      <div className="p-4 space-y-2">
        {/* Puntos del día */}
        {dia.puntos.map((punto,idx)=>{
          const esInicio=punto.tipo==="inicio";const esDestino=punto.tipo==="destino";
          const color=esInicio?"#16a34a":esDestino?"#dc2626":"#0b315f";
          const icono=esInicio?"🟢":esDestino?"🔴":"📍";
          const seg=segmentos[idx];

          return(
            <div key={punto.id}>
              <div className="flex items-center gap-2">
                <span className="text-base flex-shrink-0">{icono}</span>
                <div className="flex-1">
                  <PlacesInput size="sm"
                    placeholder={esInicio?"Punto de inicio del día...":esDestino?"Punto de llegada (hotel, destino)...":"Parada intermedia..."}
                    value={punto.texto} mapsLoaded={mapsLoaded}
                    onChange={v=>updPunto(punto.id,{texto:v,place:placeVigente(v,punto.place)})}
                    onSelect={p=>updPunto(punto.id,{texto:p.address,place:p.placeId?p:null})}/>
                </div>
                {punto.tipo==="parada"&&dia.puntos.length>2&&(
                  <button onClick={()=>eliminarPunto(punto.id)} className="text-gray-300 hover:text-red-400 font-bold flex-shrink-0">✕</button>
                )}
              </div>
              {idx<dia.puntos.length-1&&(
                <div className="ml-6 px-2">
                  {seg?<TramoInfo seg={seg}/>:<div className="h-3 border-l-2 border-dashed border-gray-200 ml-1"/>}
                </div>
              )}
            </div>
          );
        })}

        {/* Agregar parada */}
        <button onClick={agregar}
          className="w-full py-1.5 rounded-lg border border-dashed text-xs font-bold text-[#0b315f] hover:bg-blue-50 transition-colors"
          style={{borderColor:"#0b315f44"}}>
          + Agregar parada
        </button>

        {/* Pernocte y viáticos */}
        <div className="grid grid-cols-2 gap-2 mt-2">
          {[
            {l:"🛏 Pernocte bus S/",k:"pernocte" as const,v:dia.pernocte},
            {l:"👤 Viáticos chofer S/",k:"viaticos" as const,v:dia.viaticos},
          ].map(fi=>(
            <div key={fi.k}>
              <label className="block text-[9px] font-bold text-gray-400 uppercase mb-1">{fi.l}</label>
              <input type="number" min={0} value={fi.v||""} placeholder="0"
                onChange={e=>onChange({...dia,[fi.k]:Number(e.target.value)||0})}
                className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs font-bold outline-none focus:border-[#0b315f] text-center"/>
            </div>
          ))}
        </div>

        {/* Resumen del día — solo con todos los tramos resueltos; si alguno
            falló se avisa en rojo en vez de mostrar un total corto. */}
        {(kmTotal>0||diaIncompleto)&&!cargando&&(
          <div className={`rounded-lg border px-3 py-2 flex justify-between items-center ${diaIncompleto?"bg-red-50 border-red-200":"bg-blue-50 border-blue-200"}`}>
            <span className={`text-xs font-bold ${diaIncompleto?"text-red-600":"text-blue-700"}`}>
              {conError?"⚠ Tramo sin ruta · km incompleto":puntosSinPlace?"⚠ Falta elegir una dirección de la lista":`${dia.puntos.length-1} tramo${dia.puntos.length>2?"s":""}`}
            </span>
            <span className={`font-black ${diaIncompleto?"text-red-600":"text-blue-700"}`}>{diaIncompleto?"—":`${kmTotal} km`}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function RutaMultiDia({mapsLoaded,onUpdate}:{
  mapsLoaded:boolean;
  onUpdate:(km:number,dias:DiaPlan[])=>void;
}){
  const [dias,setDias]=useState<DiaPlan[]>([
    {id:uid(),numero:1,puntos:[PUNTO_VACIO("inicio"),PUNTO_VACIO("destino")],segmentos:[],pernocte:0,viaticos:0},
  ]);

  const kmTotal=dias.reduce((s,d)=>s+d.segmentos.reduce((ss,seg)=>ss+(seg?.km||0),0),0);
  const pernocteTotal=dias.reduce((s,d)=>s+d.pernocte,0);
  const viaticosTotal=dias.reduce((s,d)=>s+d.viaticos,0);
  // Si algún día tiene tramos en cálculo —o alguno terminó sin ruta— `kmTotal`
  // es parcial: no se propaga al cotizador. El fallo se detecta por `error`, no
  // por `km<=0`: un tramo de menos de 500 m redondea a 0 y es válido.
  const cargandoDias=dias.some(d=>d.segmentos.some(s=>s?.loading));
  const diasConError=dias.some(d=>d.segmentos.some(s=>s&&!s.loading&&!!s.error));
  // Igual que en RutaConParadas: un punto escrito a mano no llega a Google y el
  // día se calcularía saltándoselo.
  const diasSinPlace=dias.some(d=>d.puntos.some(p=>p.texto.trim()!==""&&!p.place));
  const diasIncompletos=diasConError||diasSinPlace;

  useEffect(()=>{onUpdate(cargandoDias||diasIncompletos?0:kmTotal,dias);},[kmTotal,cargandoDias,diasIncompletos,JSON.stringify(dias.map(d=>({p:d.pernocte,v:d.viaticos})))]);

  const agregarDia=()=>setDias(d=>[...d,{
    id:uid(),numero:d.length+1,
    puntos:[PUNTO_VACIO("inicio"),PUNTO_VACIO("destino")],
    segmentos:[],pernocte:0,viaticos:0,
  }]);

  const eliminarDia=(id:string)=>setDias(d=>d.filter(x=>x.id!==id).map((x,i)=>({...x,numero:i+1})));
  const updDia=(id:string,d:DiaPlan)=>setDias(prev=>prev.map(x=>x.id===id?d:x));

  return(
    <div className="space-y-4">
      {dias.map(dia=>(
        <DiaPlanRow key={dia.id} dia={dia} mapsLoaded={mapsLoaded}
          onChange={d=>updDia(dia.id,d)}
          onEliminar={()=>eliminarDia(dia.id)}
          puedeEliminar={dias.length>1}/>
      ))}

      <button onClick={agregarDia}
        className="w-full py-3 rounded-2xl border-2 border-dashed font-bold text-sm hover:bg-blue-50 transition-colors"
        style={{borderColor:"#0b315f44",color:"#0b315f"}}>
        + Agregar día {dias.length+1}
      </button>

      {/* Resumen total — no se pinta mientras haya días calculando (sería un
          total parcial contradiciendo al panel de resultados). */}
      {(kmTotal>0||diasIncompletos)&&!cargandoDias&&(
        <div className="rounded-2xl bg-[#0b315f] text-white p-4 space-y-2">
          <p className="text-[10px] font-black uppercase tracking-wider opacity-60">Resumen del viaje completo</p>
          {diasIncompletos&&(
            <div className="rounded-xl bg-red-500/20 border border-red-300/40 px-3 py-2">
              <p className="text-[10px] font-black text-red-200">{diasConError?"⚠ Algún día tiene un tramo sin ruta":"⚠ Falta elegir una dirección de la lista"}</p>
              <p className="text-[10px] text-red-100/80 leading-snug">Los km totales están incompletos y NO se usan en la cotización. Corrige el punto marcado en rojo.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {[
              {l:"Total días",v:`${dias.length} días`,c:"#6ee7b7"},
              {l:"KM totales",v:diasIncompletos?`${kmTotal} km (incompleto)`:`${kmTotal} km`,c:diasIncompletos?"#fca5a5":"#93c5fd"},
              {l:"Pernocte total",v:fmt(pernocteTotal),c:"#fcd34d"},
              {l:"Viáticos total",v:fmt(viaticosTotal),c:"#fca5a5"},
            ].map(k=>(
              <div key={k.l} className="bg-white/10 rounded-xl p-2.5">
                <p className="text-[9px] font-bold uppercase opacity-60">{k.l}</p>
                <p className="font-black text-sm mt-0.5" style={{color:k.c}}>{k.v}</p>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-white/50 space-y-0.5">
            {dias.map(d=>{
              const km=d.segmentos.reduce((s,seg)=>s+(seg?.km||0),0);
              const extra=d.pernocte>0?" · Pernocte "+fmt(d.pernocte):"";
              return km>0&&<p key={d.id}>{"Día "+d.numero+": "+km+" km"+extra}</p>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// WRAPPER: BUILDER DE RUTA
// ══════════════════════════════════════════════════════════════════

function RutaBuilder({tipoServ,modo,mapsLoaded,onUpdate}:{
  tipoServ:string; modo:"eventual"|"fijo"; mapsLoaded:boolean;
  onUpdate:(km:number,meta:any)=>void;
}){
  const esSimple   =["solo_ida","ida_retorno","fijo_solo_ida","transporte_personal","fijo_reten"].includes(tipoServ);
  const esConParadas=["ida_retorno_paradas","full_day","fijo_multiparada"].includes(tipoServ);
  const esMultiDia =tipoServ==="multi_dia";
  const esReten    =tipoServ==="fijo_reten";

  if(esReten) return(
    <div className="space-y-3">
      <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
        <p className="font-black text-amber-700 text-sm">🏭 Retén / Planta</p>
        <p className="text-xs text-amber-600 mt-1">Unidad disponible en planta. Ingresa km estimados de desplazamientos internos (puede ser 0).</p>
      </div>
      <div>
        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-wider mb-1">Km estimados (puede ser 0)</label>
        <input type="number" min={0} defaultValue={0} onChange={e=>onUpdate(Number(e.target.value)||0,{})}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono font-bold outline-none focus:border-[#0b315f] text-center"/>
      </div>
    </div>
  );

  if(esSimple) return <RutaSimple tipoServ={tipoServ} mapsLoaded={mapsLoaded} onUpdate={(km,o,d)=>onUpdate(km,{origen:o,destino:d})}/>;
  if(esConParadas) return <RutaConParadas tipoServ={tipoServ} mapsLoaded={mapsLoaded} onUpdate={(km,puntos)=>onUpdate(km,{puntos})}/>;
  if(esMultiDia) return <RutaMultiDia mapsLoaded={mapsLoaded} onUpdate={(km,dias)=>onUpdate(km,{dias})}/>;
  return null;
}

// ══════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════

export default function CotizadorPage(){
  const router=useRouter();
  const mapsLoaded=useGoogleMaps();

  const [flota,   setFlota]   =useState<ParamCosto[]>([]);
  const [precios, setPrecios] =useState<Record<string,number>>({});
  const [dbReady, setDbReady] =useState(false);

  useEffect(()=>{
    async function cargar(){
      const[pR,cR]=await Promise.all([
        supabase.from("parametros_costos").select("*").eq("activo",true).order("grupo_vehiculo").order("capacidad"),
        supabase.from("precios_combustible").select("tipo,precio"),
      ]);
      const f=pR.data||[];const pr:Record<string,number>={};
      (cR.data||[]).forEach((c:any)=>{pr[c.tipo]=Number(c.precio);});
      setFlota(f);setPrecios(pr);
      const bus=f.find((v:ParamCosto)=>v.grupo_vehiculo==="Buses")||f[0];
      if(bus)setIdxVeh(bus.tipo_vehiculo);
      setDbReady(true);
    }
    cargar();
  },[]);

  const [idxVeh,    setIdxVeh]    =useState("");
  const [equip,     setEquip]     =useState<"full_equipo"|"basico">("full_equipo");
  const [modo,      setModo]      =useState<"eventual"|"fijo">("eventual");
  const [tipoServEv,setTipoServEv]=useState("solo_ida");
  const [tipoServFj,setTipoServFj]=useState("transporte_personal");
  const [peajes,    setPeajes]    =useState(24);
  const [otros,     setOtros]     =useState(0);
  const [dias,      setDias]      =useState(1);
  const [cliente,   setCliente]   =useState("");
  const [kmRuta,    setKmRuta]    =useState(0);
  const [metaRuta,  setMetaRuta]  =useState<any>({});
  const [pernocteExtra,setPernocteExtra]=useState(0);
  const [viaticosExtra,setViaticosExtra]=useState(0);
  const [enviando,  setEnviando]  =useState(false);
  const [enviado,   setEnviado]   =useState(false);
  const [errorEnv,  setErrorEnv]  =useState("");

  const tipoServ=modo==="eventual"?tipoServEv:tipoServFj;
  const enOf=enHorario();
  const veh=flota.find(v=>v.tipo_vehiculo===idxVeh);

  const grupos=useMemo(()=>{
    const m:Record<string,ParamCosto[]>={};
    flota.forEach(v=>{const g=v.grupo_vehiculo||"Otros";if(!m[g])m[g]=[];m[g].push(v);});
    return m;
  },[flota]);

  // Pernocte y viáticos: vienen de meta si es multi-día, si no se ingresan aparte
  const esMultiDia=tipoServ==="multi_dia";
  const pernocteTotal=esMultiDia
    ?(metaRuta.dias||[]).reduce((s:number,d:any)=>s+d.pernocte,0)
    :pernocteExtra;
  const viaticosTotal=esMultiDia
    ?(metaRuta.dias||[]).reduce((s:number,d:any)=>s+d.viaticos,0)
    :viaticosExtra;

  const resultado=useMemo(()=>{
    if(!veh||kmRuta<=0)return null;
    return calcular(veh,precios,kmRuta,dias,peajes,otros,pernocteTotal,viaticosTotal);
  },[veh,precios,kmRuta,dias,peajes,otros,pernocteTotal,viaticosTotal]);

  const comparativo=useMemo(()=>
    flota.map(v=>({v,r:kmRuta>0?calcular(v,precios,kmRuta,dias,peajes,otros,pernocteTotal,viaticosTotal):null})),
    [flota,precios,kmRuta,dias,peajes,otros,pernocteTotal,viaticosTotal]
  );

  const handleRutaUpdate=useCallback((km:number,meta:any)=>{
    setKmRuta(km);setMetaRuta(meta);
  },[]);

  async function enviar(){
    if(!resultado||!veh)return;
    setEnviando(true);setErrorEnv("");
    const{error}=await supabase.from("cotizaciones").insert({
      origen:metaRuta.origen||null,destino:metaRuta.destino||null,
      km:kmRuta,tipo:modo==="fijo"?"transporte_personal":"eventual",
      estado:"pendiente",modo_servicio:modo,tipo_servicio:tipoServ,
      tipo_vehiculo:veh.tipo_vehiculo,equipamiento:equip,
      precio_cliente:modo==="eventual"?resultado.totalEst20:resultado.diaEstIGV,
      costo_estimado:resultado.baseCosto,
      margen_estimado:modo==="eventual"?resultado.totalEst20-resultado.baseCosto:resultado.diaEstIGV-resultado.baseCosto,
      precio_cotizador:modo==="eventual"?resultado.totalEst20:resultado.diaEstIGV,
      costo_cotizador:resultado.baseCosto,margen_cotizador:20,
      vehiculo_cotizador:veh.nombre,
      precio_dia:modo==="fijo"?resultado.diaEstIGV:null,
      precio_mes_estimado:modo==="fijo"?resultado.mesEstIGV:null,
      dias_servicio:modo==="eventual"?dias:1,
      pernocte_costo:pernocteTotal||null,modo_precio:"cotizador",
      paradas_json:metaRuta.puntos||null,
      observaciones:[
        cliente?`Cliente: ${cliente}`:null,
        `Vehículo: ${veh.nombre}`,`KM: ${kmRuta} km`,
        pernocteTotal>0?`Pernocte: ${fmt(pernocteTotal)}`:null,
        viaticosTotal>0?`Viáticos: ${fmt(viaticosTotal)}`:null,
        `Modo: ${modo.toUpperCase()} · ${tipoServ}`,
      ].filter(Boolean).join(" | "),
    });
    setEnviando(false);
    if(error){setErrorEnv(error.message);return;}
    setEnviado(true);setTimeout(()=>router.push("/cotizaciones"),1800);
  }

  if(!dbReady)return(<div className="min-h-screen bg-[#eef3f8] flex items-center justify-center"><div className="text-center"><div className="w-12 h-12 border-4 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-4"/><p className="font-bold text-[#0b315f]">Cargando flota...</p></div></div>);
  if(flota.length===0)return(<div className="min-h-screen bg-[#eef3f8] flex items-center justify-center"><div className="text-center bg-white rounded-2xl p-8 shadow-sm border max-w-md"><p className="text-3xl mb-3">🚌</p><p className="font-black text-[#0b315f] text-lg">Sin vehículos activos</p><a href="/ajustes" className="inline-block mt-4 px-5 py-2.5 rounded-xl bg-[#0b315f] text-white font-bold text-sm">→ Ajuste de Costos</a></div></div>);

  return(
    <div className="min-h-screen bg-[#eef3f8]">
      <div className="max-w-[1400px] mx-auto px-5 py-6 space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-black text-[#0b315f]">Cotizador de Tarifas</h1>
            <p className="text-sm text-gray-400 mt-1">{flota.length} vehículos · Google Maps · Km calculado por tipo de servicio</p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <a href="/ajustes" className="text-xs text-gray-400 hover:text-[#0b315f] font-bold border border-gray-200 rounded-xl px-3 py-2">⚙️ Ajustar costos</a>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold border ${enOf?"bg-green-50 border-green-200 text-green-700":"bg-amber-50 border-amber-200 text-amber-700"}`}>
              {enOf?"🟢 Horario de oficina":"🟡 Fuera de horario"}
            </div>
          </div>
        </div>

        {/* Precios activos */}
        <div className="flex gap-2 flex-wrap">
          {Object.entries(precios).filter(([t])=>t!=="UREA").map(([tipo,precio])=>(
            <div key={tipo} className="px-3 py-1.5 rounded-xl border text-xs font-bold" style={{background:COMB_COLOR[tipo]+"15",borderColor:COMB_COLOR[tipo]+"44",color:COMB_COLOR[tipo]}}>
              ⛽ {tipo}: S/ {precio.toFixed(2)}/{tipo==="GNV"?"m³":"gal"}
            </div>
          ))}
          {precios["UREA"]&&<div className="px-3 py-1.5 rounded-xl border text-xs font-bold bg-cyan-50 border-cyan-300 text-cyan-700">🧪 UREA: S/ {precios["UREA"].toFixed(2)}/litro</div>}
        </div>

        {/* Modo toggle */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="grid grid-cols-2">
            {[{id:"eventual",label:"📋 EVENTUAL",sub:"Precio total por evento",color:"#0b315f",bg:"#eef3f8",desc:"Cotización / Orden de Servicio"},{id:"fijo",label:"📅 FIJO",sub:"Precio por día · contratos",color:"#166534",bg:"#dcfce7",desc:"Contrato Mensual / Liquidación"}].map(m=>(
              <button key={m.id} onClick={()=>setModo(m.id as any)} className="py-4 px-6 text-left border-b-4 transition-all" style={{borderColor:modo===m.id?m.color:"transparent",background:modo===m.id?m.bg:"white",color:modo===m.id?m.color:"#9ca3af"}}>
                <p className="font-black text-lg">{m.label}</p><p className="text-sm font-bold opacity-80">{m.sub}</p><p className="text-[11px] opacity-50 mt-0.5">{m.desc}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

          {/* ── INPUTS ── */}
          <div className="xl:col-span-1 space-y-4">

            {/* Cliente */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider mb-2">Datos del servicio</p>
              <input value={cliente} onChange={e=>setCliente(e.target.value)} placeholder="Empresa cliente (opcional)"
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f]"/>
            </div>

            {/* Tipo de servicio */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider mb-3">Tipo de servicio</p>
              <div className="space-y-1.5">
                {(modo==="eventual"?[
                  {id:"solo_ida",          label:"➡️ Solo Ida",           sub:"KM × 1"},
                  {id:"ida_retorno",        label:"⇄ Ida y Retorno",       sub:"KM × 2 automático"},
                  {id:"ida_retorno_paradas",label:"📍 Con Paradas",         sub:"Suma tramos · retorno configurable"},
                  {id:"full_day",           label:"⭐ Full Day / Tour",     sub:"Suma tramos · retorno configurable"},
                  {id:"multi_dia",          label:"🏕️ Multi-día",           sub:"Itinerario propio por día"},
                ]:[
                  {id:"fijo_solo_ida",      label:"→ Solo Ida",            sub:"KM × 1"},
                  {id:"transporte_personal",label:"⇄ Ida y Retorno",       sub:"KM × 2 automático"},
                  {id:"fijo_multiparada",   label:"📍 Con Paraderos",       sub:"Suma tramos · retorno configurable"},
                  {id:"fijo_reten",         label:"🏭 Retén / Planta",      sub:"KM manual (puede ser 0)"},
                ]).map(s=>{
                  const act=modo==="eventual"?tipoServEv===s.id:tipoServFj===s.id;
                  const color=modo==="eventual"?"#0b315f":"#166534";const bg=modo==="eventual"?"#eef3f8":"#dcfce7";
                  return(
                    <button key={s.id} onClick={()=>{modo==="eventual"?setTipoServEv(s.id):setTipoServFj(s.id);setKmRuta(0);setMetaRuta({});}}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border-2 text-left transition-all"
                      style={{background:act?bg:"white",borderColor:act?color:"#e5e7eb",color:act?color:"#6b7280"}}>
                      <div><p className="font-bold text-sm">{s.label}</p><p className="text-[9px] opacity-60">{s.sub}</p></div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── BUILDER DE RUTA ── */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider">📍 Ruta</p>
                {mapsLoaded
                  ?<span className="text-[9px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">Google Maps activo</span>
                  :<span className="text-[9px] text-gray-400 animate-pulse">Cargando Maps...</span>}
              </div>
              <RutaBuilder
                key={tipoServ} // reset al cambiar tipo
                tipoServ={tipoServ} modo={modo}
                mapsLoaded={mapsLoaded}
                onUpdate={handleRutaUpdate}/>
            </div>

            {/* Variables adicionales */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-4">
              <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider">Variables</p>
              {modo==="eventual"&&!esMultiDia&&(
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase block mb-1.5">Días de conductor</label>
                  <div className="flex items-center gap-1">
                    <button onClick={()=>setDias(Math.max(1,dias-1))} className="w-9 h-9 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold">-</button>
                    <span className="flex-1 text-center font-black text-[#0b315f]">{dias}</span>
                    <button onClick={()=>setDias(Math.min(30,dias+1))} className="w-9 h-9 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold">+</button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                {[{l:"Peajes S/",v:peajes,s:setPeajes},{l:"Otros S/",v:otros,s:setOtros}].map(fi=>(
                  <div key={fi.l}><label className="text-[10px] font-bold text-gray-400 uppercase block mb-1.5">{fi.l}</label><input type="number" value={fi.v} onChange={e=>fi.s(Number(e.target.value))} min={0} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] text-center"/></div>
                ))}
              </div>
              {/* Pernocte/viáticos manuales solo si no es multi-día */}
              {!esMultiDia&&(tipoServ==="full_day"||modo==="eventual")&&(
                <div className="grid grid-cols-2 gap-3">
                  {[{l:"🛏 Pernocte bus S/",v:pernocteExtra,s:setPernocteExtra},{l:"👤 Viáticos chofer S/",v:viaticosExtra,s:setViaticosExtra}].map(fi=>(
                    <div key={fi.l}><label className="text-[10px] font-bold text-purple-600 uppercase block mb-1">{fi.l}</label><input type="number" value={fi.v||""} onChange={e=>fi.s(Number(e.target.value)||0)} min={0} placeholder="0" className="w-full border border-purple-200 rounded-xl px-3 py-2 text-sm font-bold text-purple-700 outline-none bg-white text-center"/></div>
                  ))}
                </div>
              )}
            </div>

            {/* Vehículo */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] font-black text-gray-400 uppercase tracking-wider">🚌 Vehículo</p>
                <div className="flex rounded-xl border overflow-hidden flex-shrink-0">
                  {[{val:"full_equipo",icon:"⭐",label:"Full Equipo"},{val:"basico",icon:"📦",label:"Básico"}].map(e=>(
                    <button key={e.val} onClick={()=>setEquip(e.val as "full_equipo"|"basico")}
                      className="px-2.5 py-1 text-[10px] font-bold transition-all"
                      style={{background:equip===e.val?"#0b315f":"white",color:equip===e.val?"white":"#0b315f"}}>
                      {e.icon} {e.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                {Object.entries(grupos).map(([grupo,vehs])=>{
                  const gc=GRUPO_CFG[grupo]||GRUPO_CFG.Otros;
                  return(<div key={grupo}><p className="text-[9px] font-black uppercase tracking-wider mb-1.5" style={{color:gc.color}}>{grupo}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {vehs.map(v=>{const act=v.tipo_vehiculo===idxVeh;return(
                      <button key={v.tipo_vehiculo} onClick={()=>setIdxVeh(v.tipo_vehiculo)}
                        className="flex flex-col items-center px-2 py-2 rounded-xl border-2 transition-all text-center"
                        style={{background:act?gc.bg:"white",borderColor:act?gc.color:"#e5e7eb",color:act?gc.color:"#9ca3af"}}>
                        <span className="text-xl">{v.icono||"🚌"}</span>
                        <span className="text-[9px] font-bold leading-tight mt-0.5">{v.nombre}</span>
                        {v.usa_urea&&<span className="text-[8px] text-cyan-600 font-bold">🧪</span>}
                      </button>
                    );})}
                  </div></div>);
                })}
              </div>
              {veh&&(
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[{l:"Capacidad",v:`${veh.capacidad} pax`},{l:"Combustible",v:veh.tipo_combustible_1},{l:"Rendimiento",v:`${veh.rendimiento_1} km/${veh.tipo_combustible_1==="GNV"?"m³":"gal"}`},{l:"Conductor",v:`S/ ${veh.conductor_dia}/día`}].map(i=>(
                    <div key={i.l} className="bg-[#eef3f8] rounded-lg px-2.5 py-2"><p className="text-[9px] font-bold text-gray-400 uppercase">{i.l}</p><p className="text-xs font-black text-[#0b315f] mt-0.5">{i.v}</p></div>
                  ))}
                  {veh.usa_urea&&<div className="col-span-2 bg-cyan-50 border border-cyan-200 rounded-lg px-2.5 py-2"><p className="text-[10px] font-black text-cyan-700">🧪 UREA · {veh.euronorm}</p><p className="text-[9px] text-cyan-600">~{((veh.consumo_urea_pct||0.04)*100).toFixed(0)}% del diésel</p></div>}
                </div>
              )}
            </div>
          </div>

          {/* ── RESULTADOS ── */}
          <div className="xl:col-span-2 space-y-4">

            {kmRuta<=0?(
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 text-center">
                <p className="text-4xl mb-3">📍</p>
                <p className="font-bold text-gray-600">Ingresa la ruta para calcular</p>
                <p className="text-sm text-gray-400 mt-1">El km se calcula automáticamente con Google Maps según el tipo de servicio</p>
              </div>
            ):resultado&&veh?(
              <>
                {/* KM badge */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-5 py-4 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">KM calculado</p>
                    <p className="font-black text-3xl text-[#0b315f]">{kmRuta} km</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {tipoServ==="solo_ida"||tipoServ==="fijo_solo_ida"?"Solo ida × 1":tipoServ==="ida_retorno"||tipoServ==="transporte_personal"?"Ida y retorno × 2":tipoServ==="multi_dia"?"Suma de todos los días":"Suma de tramos"}
                    </p>
                  </div>
                  <div className="text-right">
                    {pernocteTotal>0&&<p className="text-xs text-purple-600 font-bold">🛏 Pernocte: {fmt(pernocteTotal)}</p>}
                    {viaticosTotal>0&&<p className="text-xs text-purple-600 font-bold">👤 Viáticos: {fmt(viaticosTotal)}</p>}
                  </div>
                </div>

                {/* Precios */}
                {modo==="eventual"?(
                  <div className="grid grid-cols-3 gap-3">
                    {[{label:"⛔ Mínimo (15%)",val:resultado.totalMin15,sinIgv:resultado.sinIGV15,color:"#ef4444",bg:"#fef2f2",border:"#fecaca"},{label:"✅ Estándar (20%)",val:resultado.totalEst20,sinIgv:resultado.sinIGV20,color:"#16a34a",bg:"#f0fdf4",border:"#86efac"},{label:"⭐ Premium (25%)",val:resultado.totalAlto25,sinIgv:resultado.sinIGV25,color:"#6d28d9",bg:"#faf5ff",border:"#d8b4fe"}].map(k=>(
                      <div key={k.label} className="rounded-2xl p-4 border-2" style={{background:k.bg,borderColor:k.border}}>
                        <p className="text-[10px] font-bold uppercase text-gray-400">{k.label}</p>
                        <p className="font-black text-xl mt-1" style={{color:k.color}}>{fmt(k.val)}</p>
                        <p className="text-[11px] text-gray-400 mt-1">Sin IGV: {fmt(k.sinIgv)}</p>
                        {k.label.includes("20%")&&<p className="text-[10px] text-green-600 font-bold mt-0.5">S/ {fmtN(resultado.precioPax20,0)}/pax</p>}
                      </div>
                    ))}
                  </div>
                ):(
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      {[{label:"⛔ Día mín. (15%)",val:resultado.diaMinIGV,color:"#ef4444",bg:"#fef2f2",border:"#fecaca"},{label:"✅ Día est. (20%)",val:resultado.diaEstIGV,color:"#16a34a",bg:"#f0fdf4",border:"#86efac"},{label:"⭐ Día prem. (25%)",val:resultado.diaAltoIGV,color:"#6d28d9",bg:"#faf5ff",border:"#d8b4fe"}].map(k=>(
                        <div key={k.label} className="rounded-2xl p-4 border-2" style={{background:k.bg,borderColor:k.border}}>
                          <p className="text-[10px] font-bold uppercase text-gray-400">{k.label}</p>
                          <p className="font-black text-xl mt-1" style={{color:k.color}}>{fmt(k.val)}</p>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-2xl border-2 border-green-300 bg-green-50 p-5 flex items-center justify-between">
                      <div><p className="text-[11px] font-bold text-green-600 uppercase">Estimado mensual (20% · ×26 días)</p><p className="font-black text-3xl text-green-700 mt-1">{fmt(resultado.mesEstIGV)}</p><p className="text-xs text-green-600 mt-1">{fmt(resultado.diaEstIGV)}/día × 26 = {fmt(resultado.mesEstIGV)}/mes</p></div>
                      <div className="text-4xl">📅</div>
                    </div>
                  </div>
                )}

                {/* Desglose */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-5 py-4 border-b"><h2 className="font-black text-[#0b315f] text-sm">Desglose de costos</h2><p className="text-xs text-gray-400 mt-0.5">{veh.icono||"🚌"} {veh.nombre} · {kmRuta} km{veh.usa_urea?" · 🧪 UREA":""}</p></div>
                  <div className="p-5 space-y-2">
                    {[
                      {label:`Combustible (${veh.tipo_combustible_1})`,val:resultado.costoCombustible-resultado.costoUrea,color:COMB_COLOR[veh.tipo_combustible_1]||"#666"},
                      ...(resultado.costoUrea>0?[{label:`🧪 UREA (${((veh.consumo_urea_pct||0.04)*100).toFixed(0)}% diésel)`,val:resultado.costoUrea,color:"#06b6d4"}]:[]),
                      {label:`Neumáticos (${veh.n_neumaticos} unid)`,val:resultado.costoNeumaticos,color:"#8b5cf6"},
                      {label:"Mantenimiento preventivo",val:resultado.costoMantenimiento,color:"#10b981"},
                      {label:"Depreciación",val:resultado.costoDeprec,color:"#60a5fa"},
                      {label:"Seguros, SOAT, permisos",val:resultado.costoFijosKm,color:"#f87171"},
                      {label:"Reserva (5%)",val:resultado.reserva,color:"#94a3b8"},
                      {label:`Conductor (S/ ${veh.conductor_dia}/día)`,val:resultado.costoConductor,color:"#fb923c"},
                      {label:"Peajes y otros",val:resultado.costoDirectos,color:"#94a3b8"},
                    ].map(item=>(
                      <div key={item.label} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0"><p className="text-xs text-gray-500 truncate">{item.label}</p><div className="h-1.5 rounded-full bg-gray-100 mt-1 overflow-hidden"><div className="h-full rounded-full" style={{width:`${Math.min(item.val/resultado.costoDirectoTotal*100,100)}%`,background:item.color}}/></div></div>
                        <span className="text-xs font-bold text-[#0b315f] flex-shrink-0 w-24 text-right">{fmt(item.val)}</span>
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      {[{l:"Costo directo",v:resultado.costoDirectoTotal,b:false},{l:"Overhead (10%)",v:resultado.overhead,b:false},{l:"Base costo completo",v:resultado.baseCosto,b:true},{l:"Costo S/km",v:`S/ ${fmtN(resultado.costoKm,2)}/km`,b:false,t:true}].map(r=>(
                        <div key={r.l} className={`flex justify-between items-center px-3 py-2 rounded-xl ${r.b?"bg-[#eef3f8]":"bg-gray-50"}`}>
                          <span className={`text-xs ${r.b?"font-black text-[#0b315f]":"text-gray-500 font-semibold"}`}>{r.l}</span>
                          <span className={`text-sm ${r.b?"font-black text-[#0b315f]":"font-bold text-gray-600"}`}>{r.t?r.v:fmt(r.v as number)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Enviar */}
                <div className="rounded-2xl border-2 overflow-hidden" style={{background:enviado?"#f0fdf4":"#0b315f",borderColor:enviado?"#86efac":"#0b315f"}}>
                  {enviado?(
                    <div className="p-6 text-center"><p className="text-3xl mb-2">✅</p><p className="font-black text-green-700">Cotización creada</p><p className="text-green-600 text-sm mt-1">Redirigiendo...</p></div>
                  ):(
                    <div className="p-5">
                      <h3 className="font-black text-white text-base mb-1">→ Enviar a Cotizaciones</h3>
                      <p className="text-white/60 text-xs mb-4">{modo==="fijo"?`FIJO · ${fmt(resultado.diaEstIGV)}/día · mes ${fmt(resultado.mesEstIGV)}`:`EVENTUAL · total ${fmt(resultado.totalEst20)}`} · {kmRuta} km</p>
                      <div className="grid grid-cols-3 gap-3 mb-4">
                        {(modo==="eventual"?[{label:"Costo base",val:fmt(resultado.baseCosto),color:"#fca5a5"},{label:"Sin IGV",val:fmt(resultado.sinIGV20),color:"#fcd34d"},{label:"Total final",val:fmt(resultado.totalEst20),color:"#6ee7b7"}]:[{label:"Precio/día",val:fmt(resultado.diaEstIGV),color:"#6ee7b7"},{label:"Mes est.",val:fmt(resultado.mesEstIGV),color:"#a78bfa"},{label:"Costo/día",val:fmt(resultado.baseCosto),color:"#fca5a5"}]).map(k=>(
                          <div key={k.label} className="bg-white/10 rounded-xl p-3 text-center"><p className="text-white/50 text-[10px] font-bold uppercase">{k.label}</p><p className="font-black text-sm mt-0.5" style={{color:k.color}}>{k.val}</p></div>
                        ))}
                      </div>
                      {errorEnv&&<p className="text-red-300 text-xs font-semibold bg-red-500/20 rounded-xl px-3 py-2 mb-3">⚠ {errorEnv}</p>}
                      <button onClick={enviar} disabled={enviando} className="w-full py-3.5 rounded-xl font-black text-sm bg-white text-[#0b315f] hover:bg-gray-100 disabled:opacity-50">
                        {enviando?"Creando...": `→ Crear cotización ${modo.toUpperCase()} · ${modo==="eventual"?fmt(resultado.totalEst20):fmt(resultado.diaEstIGV)+"/día"}`}
                      </button>
                    </div>
                  )}
                </div>

                {/* Comparativo */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-5 py-4 border-b"><h2 className="font-black text-[#0b315f] text-sm">Comparativo flota · {kmRuta} km · margen 20%</h2></div>
                  {Object.entries(grupos).map(([grupo,vehs])=>{
                    const gc=GRUPO_CFG[grupo]||GRUPO_CFG.Otros;
                    return(<div key={grupo}><div className="px-4 py-2 text-[10px] font-black uppercase tracking-wider border-b" style={{background:gc.color+"15",color:gc.color}}>{grupo}</div>
                    <table className="w-full text-sm"><thead><tr className="bg-gray-50 border-b">{["Vehículo","Cap.",modo==="eventual"?"Total (20%)":"Día (20%)",modo==="eventual"?"S/pax":"Mes ×26","Mín 15%","UREA"].map(h=><th key={h} className="px-3 py-2 text-left text-[10px] font-black text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr></thead>
                    <tbody className="divide-y divide-gray-50">
                      {vehs.map(v=>{
                        const item=comparativo.find(c=>c.v.tipo_vehiculo===v.tipo_vehiculo);
                        if(!item?.r)return null;const r=item.r;const act=v.tipo_vehiculo===idxVeh;
                        return(<tr key={v.tipo_vehiculo} onClick={()=>setIdxVeh(v.tipo_vehiculo)} className={`cursor-pointer transition-colors ${act?"bg-blue-50 border-l-2 border-l-[#0b315f]":"hover:bg-gray-50"}`}>
                          <td className="px-3 py-2.5"><span className={`text-xs ${act?"font-black text-[#0b315f]":"font-semibold text-gray-600"}`}>{v.icono||"🚌"} {v.nombre}</span>{act&&<span className="ml-1 text-[9px] font-black bg-[#0b315f] text-white px-1.5 py-0.5 rounded">SEL</span>}</td>
                          <td className="px-3 py-2.5 text-xs text-gray-500">{v.capacidad}p</td>
                          <td className="px-3 py-2.5 text-xs font-black text-[#0b315f] font-mono">{fmt(modo==="eventual"?r.totalEst20:r.diaEstIGV)}</td>
                          <td className="px-3 py-2.5 text-xs font-bold text-gray-500 font-mono">{modo==="eventual"?`S/ ${fmtN(r.precioPax20,0)}`:fmt(r.mesEstIGV)}</td>
                          <td className="px-3 py-2.5 text-xs text-amber-600 font-mono">{fmt(modo==="eventual"?r.totalMin15:r.diaMinIGV)}</td>
                          <td className="px-3 py-2.5 text-center">{v.usa_urea?<span className="text-[10px] text-cyan-600 font-bold">🧪</span>:<span className="text-gray-200 text-xs">—</span>}</td>
                        </tr>);
                      })}
                    </tbody></table></div>);
                  })}
                </div>
              </>
            ):null}
          </div>
        </div>
      </div>
    </div>
  );
}