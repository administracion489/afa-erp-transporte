"use client";
import React, { useEffect, useState, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { terminosBusqueda } from "@/lib/busqueda-texto";
import {
  PERIODOS, ETIQUETA_PERIODO, ETIQUETA_EJE, PERIODO_DEFECTO, EJE_DEFECTO, hoyLimaISO, rangoDePeriodo,
  textoBuscable, filtrarLista, kpisDe, type Periodo, type EjeFecha, type CotLista, type RangoPeriodo,
} from "@/lib/cotizaciones-filtros";
import { leerListaPeriodo, leerHistorialSelector, leerCotizacion, leerTipoCambioSugerido, type FilaHistorialSelector } from "@/lib/cotizaciones-datos";
import {
  normalizarMoneda, simboloMoneda, revisarTipoCambio, aMonedaCot, aPENdesdeCot, itemsEnMoneda, itemsAPEN,
  totalesEnMoneda, planCambioMoneda, type Moneda, type SugerenciaTc,
} from "@/lib/cotizacion-moneda";
import { normalizarIdioma, DEFAULT_CONSID_ES, descripcionServicio, type Idioma } from "@/lib/cotizacion-idioma";
import { htmlCotizacion, type AvisoPdf, type ResultadoPdf } from "@/lib/cotizacion-pdf";
import {
  CONSID_VERSION, ETIQUETA_DISENO, avisoCondicionesDeOtraPlantilla, considParaFormulario, considSnapshot, disenoDe, esActiva,
  etiquetaCelda, plantillaParaUso, plantillaPorId, plantillaPrincipal, segmentoDeCliente, servicioDeCotizacion, SQL_PLANTILLAS_USO,
  type CodigoUso, type ConsidFila, type Diseno, type PlantillaFila, type ReglaPlantilla,
} from "@/lib/cotizacion-plantillas";
import { leerPlantillasYReglas } from "@/lib/cotizacion-plantillas-datos";
import { construirPuntos, puntosDesdeTexto, puntosConCoords, firmaRutaFicha, encodePolyline, diezmar, urlMapaEstatico, urlGoogleMapsRuta, type PuntoFicha, type FichaRutaCache, type MetricaSentido } from "@/lib/ficha-ruta";
import { buildFichaRutaHtml, type FichaRutaDatos } from "@/lib/ficha-ruta-html";
import { fmtCoord, urlMapsPunto, parsearParCoordenadas, parsearCoordenada } from "@/lib/coordenadas";
import { LOGO_DEFAULT } from "@/lib/pdf-chrome";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import SelectorCliente from "@/components/SelectorCliente";
import SelectorVehiculo from "@/components/SelectorVehiculo";
import { usoPorVehiculo, recientesVehiculos } from "@/lib/vehiculos-buscador";
import { rotuloCliente, usoPorCliente, recientesDe, esBloqueado, type ClienteBuscable } from "@/lib/clientes-buscador";

/**
 * Quién EMITE la cotización, resuelto por el escalón único del ERP.
 *
 * Este archivo llevaba los datos de AFA escritos a mano —nombre, RUC, teléfono, correo, web y
 * domicilio— repetidos VEINTICINCO veces entre sus cuatro generadores de PDF. `empresa_perfil`
 * es la fuente; `empresaConDefectos` rellena y, lo que falta, lo deja VACÍO para que el pie del
 * documento omita la línea en vez de imprimir el dato de otra empresa.
 *
 * El alias es corto a propósito: el HTML de estos PDF va en una sola línea y
 * `empresaConDefectos(empresa).telefono` repetido la vuelve ilegible.
 */
const EMP = empresaConDefectos;
import { componentesCostoKm } from "@/lib/costos/costo-km-parametro";
import {
  NIVELES, NIVEL_CFG, nivelDeEquipamiento, equipamientoDeNivel, nivelDeFicha, fichasDelNivel,
  planDeNivel, cotejarUnidadConNivel, type NivelServicio,
} from "@/lib/costos/nivel-servicio";
import { ejecutarConversion } from "@/lib/cotizacion-a-reserva-datos";
import { enlaceCondiciones, SQL_RESUMEN_CONDICIONES } from "@/lib/condiciones-publicas";
import type { CotParaReserva } from "@/lib/cotizacion-a-reserva";
import { planDePropagacion, MOTIVO_NO_PROPAGA, type MotivoNoPropaga } from "@/lib/paradas-materializar";
import dynamic from "next/dynamic";
import { estadoMarca, firmaParaderos, indiceDeInsercion, type HoraCalc, type FilaPlan } from "@/lib/paradas-horario";
import { useRutaParaderos, coordsOk } from "@/components/cotizaciones/useRutaParaderos";
import BarraHorasParaderos, { etiquetaDiaCorta, type ContextoHoras } from "@/components/cotizaciones/BarraHorasParaderos";
import { coordValida, resolverRestauracion, rutaCoordsParaGuardar, rotuloFuente, type PuntoRuta, type Extremo } from "@/lib/cotizacion-ruta-coords";
import { faltaColumna, faltaAlguna } from "@/lib/columna-faltante";
import ModalDespachoSinCotizar from "@/components/cotizaciones/ModalDespachoSinCotizar";
import { AVISO_CLIENTE_NO_VERIFICADO, AVISO_TRASLADO_EN_CASTELLANO, clienteErpDe, entradaTrasladoPagina, esTrasladoIA } from "@/components/cotizaciones/pdf-traslado";
import type { FilaCotizacionLeida } from "@/lib/traslados/cotizacion-traslado";
import { leerDespachosSinCotizar, vincularCotizacion } from "@/lib/despacho-sin-cotizar-datos";
import { pendientesDeCotizar, prellenadoCotizacion, type ReservaDespacho } from "@/lib/despacho-sin-cotizar";
// hoyLima de lib/alertas NO: ese módulo crea el cliente service-role al cargarse y rompe la página en el navegador.
import { hoyLimaISO as hoyLima } from "@/lib/cotizaciones-filtros";
// El mapa arrastra el CSS de Mapbox y su motor se baja al abrirlo (lib/mapbox-carga.ts).
const MapaParaderos = dynamic(() => import("@/components/cotizaciones/MapaParaderos"), { ssr: false });

type FechaMultidia={dia:number;fecha:string;hora_ida:string;hora_fin:string;tipo_noche:"pernocte"|"cochera"|"";destino_nombre:string;destino_lat:string;destino_lng:string;};
type ParamCosto={tipo_vehiculo:string;nombre:string;capacidad:number;activo:boolean;icono:string|null;grupo_vehiculo:string|null;euronorm:string|null;usa_urea:boolean;consumo_urea_pct:number|null;tipo_combustible_1:string;rendimiento_1:number;pct_uso_1:number;tipo_combustible_2:string|null;rendimiento_2:number|null;pct_uso_2:number|null;n_neumaticos:number;costo_neumatico:number;vida_neumatico_km:number;mantenimiento_km:number;valor_compra:number;residual_pct:number;vida_util_anios:number;km_anio:number;seguro_anual:number;soat_anual:number;revision_semestral:number;permisos_anual:number;otros_fijos_mensual:number;conductor_dia:number;};
type EstadoCot="borrador"|"pendiente"|"enviado"|"aprobado"|"rechazado";
type ModoServ="eventual"|"fijo";
// `pax_contratado` = asientos que el cliente contrata para este ítem. Es el ORIGEN del
// "N PAX" que imprime la liquidación, y NO la capacidad del vehículo asignado: AFA
// asigna por disponibilidad, así que una ruta pactada para 15 puede cubrirse con un bus
// de 17 o de 20 y el formato tiene que seguir diciendo 15.
// Vive dentro de items_json (jsonb), así que no necesitó migración.
type ItemCot={descripcion:string;dias:number;cantidad:number;precio_unit:number;descuento_pct:number;pax_contratado?:number|null;vehiculo_flota_id?:number|null;vehiculo_tercero_id?:number|null;};
type ConsidCot={incluye:string[];no_incluye:string[];generales:string[];};
type Cliente={id:number;nombre:string;empresa?:string;nombre_comercial?:string;ciudad?:string;tipo?:string;ruc?:string;dni?:string;telefono?:string;email?:string;direccion?:string;estado?:string;operativo_nombre?:string;};
type Cotizacion={id:number;cliente_id:number|null;origen:string;destino:string;km:number;precio_cliente:number;costo_estimado:number;margen_estimado:number;estado:EstadoCot;numero_cotizacion:string|null;atencion:string|null;asunto:string|null;punto_retorno:string|null;fecha_servicio:string|null;fecha_retorno:string|null;hora_ida:string|null;hora_retorno:string|null;descuento_pct:number;items_json:ItemCot[]|null;numero_aprobacion:string|null;tipo_aprobacion:string|null;medio_envio:string|null;tipo_vehiculo:string|null;tipo_servicio:string|null;equipamiento:string|null;vehiculo_flota_id:number|null;vehiculo_tercero_id:number|null;consideraciones_json:ConsidFila|null;paradas_json:ParadaTP[]|null;paradas_retorno_json:ParadaTP[]|null;created_at:string;modo_servicio:ModoServ|null;dias_servicio:number|null;horas_servicio:number|null;pernocte_costo:number|null;precio_dia:number|null;precio_mes_estimado:number|null;precio_tarifario:number|null;precio_cotizador:number|null;costo_cotizador:number|null;margen_cotizador:number|null;vehiculo_cotizador:string|null;precio_sugerido:number|null;modo_precio:string|null;enviado_automatico:boolean;descuento_solicitado:boolean;descuento_pct_solicitado:number|null;descuento_autorizado:boolean;hora_solicitud_descuento:string|null;plantilla_pdf:string|null;incluye_igv:boolean|null;itinerario_texto:string|null;fechas_multidia_json:FechaMultidia[]|null;ficha_ruta_json?:FichaRutaCache|null;ruta_coords_json?:unknown;moneda?:string|null;tipo_cambio?:number|string|null;idioma_pdf?:string|null;traslado_json?:unknown;crm_conversacion_id?:string|null;condiciones_token?:string|null;};
/**
 * Una fila de la LISTA liviana (COLS_LISTA de lib/cotizaciones-filtros.ts): solo escalares, sin
 * items_json, paraderos ni consideraciones. Todo lo que edita, duplica, imprime o convierte pide
 * antes el DETALLE (`leerCotizacion`) — con la fila liviana, guardar borraría ítems y paraderos.
 */
type CotFila=Omit<CotLista,"estado"|"modo_servicio">&{estado:EstadoCot;modo_servicio:ModoServ|null};
type EmpresaPerfilPDF={nombre:string|null;razon_social:string|null;ruc:string|null;logo_url:string|null;telefono:string|null;email:string|null;direccion:string|null;color_primario:string|null;web:string|null;cuentas_bancarias?:{banco:string;cuenta:string;cci:string}[]|null;};
// `hora_calc` = la marca que deja «⏱ Calcular horas» (lib/paradas-horario.ts): con qué se calculó
// la hora y para qué paraderos. Viaja en paradas_json (jsonb), sin migración.
type ParadaTP={id:string;tipo:"inicio"|"intermedia"|"destino";nombre:string;direccion:string;lat:string;lng:string;hora:string;hora_calc?:HoraCalc;};
type Tarifa={id:number;origen:string;destino:string;tipo_vehiculo:string;equipamiento:string;tipo_servicio:string;modo:string;precio:number;moneda:string;confidencial:boolean;incluye_guia:boolean;incluye_peajes:boolean;incluye_alimentacion:boolean;notas:string|null;};
type VehiculoFlota={id:number;placa:string;categoria:string|null;marca:string|null;modelo:string|null;anio:number|null;capacidad_pasajeros:number|null;equipamiento:string|null;foto_externa_url:string|null;foto_interna_url:string|null;descripcion_unidad:string|null;tipo_vehiculo_costeo:string|null;};
type VehiculoTerceroFlota={id:number;empresa_id:number;placa:string;categoria:string|null;marca:string|null;modelo:string|null;capacidad:number|null;estado:string;empresa_nombre?:string;foto_externa_url:string|null;foto_interna_url:string|null;descripcion_unidad:string|null;tipo_vehiculo_costeo:string|null;};
// Descripción de una unidad tercerizada para un documento que lee el CLIENTE: nunca nombra
// al proveedor (ver terceroAFlota). Se compara sin tildes ni mayúsculas ni signos.
const normEmp=(x:string)=>x.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9]+/g," ").trim();
const descripcionTerceroParaCliente=(t:{placa:string;categoria:string|null;marca:string|null;capacidad:number|null;descripcion_unidad:string|null;empresa_nombre?:string}):string=>{
  const propia=(t.descripcion_unidad||"").trim();
  const emp=normEmp(t.empresa_nombre||"");
  if(propia&&!(emp&&normEmp(propia).includes(emp)))return propia;
  return `${t.placa} ${t.categoria||""} ${t.marca||""} ${t.capacidad?`(${t.capacidad} pax)`:""}`.replace(/\s+/g," ").trim();
};

const IGV=0.18,OVERHEAD=0.10,RESERVA=0.05;
/** Filas que se pintan de golpe en la lista (y cuántas más trae «Mostrar más»). */
const PASO_LISTA=50;
const CLAVE_FILTROS_COT="afa_cot_filtros_v1";
const ESTADOS_FILTRO=["todos","borrador","pendiente","enviado","aprobado","rechazado"];
const MODOS_FILTRO=["todos","eventual","fijo"];
// Las consideraciones de fábrica viven en lib/cotizacion-idioma.ts (con su versión en inglés).
const DEFAULT_CONSID:ConsidCot=DEFAULT_CONSID_ES;
/**
 * La migración de moneda e idioma (cotizaciones-04). Sin ella las tres columnas no existen: se
 * guarda en soles y en español, y el selector de dólares se apaga nombrando este archivo.
 */
const SQL_MONEDA="supabase/cotizaciones-04-moneda-idioma.sql";
const COLS_MONEDA=["moneda","tipo_cambio","idioma_pdf"] as const;
const ETQ_FUENTE_TC:Record<SugerenciaTc["fuente"],string>={tabla_tipo_cambio:"tabla de tipo de cambio",ultima_cotizacion_usd:"última cotización en dólares",sin_fuente:"sin fuente"};
const SERVS_EVENTUAL=[{id:"solo_ida",label:"➡️ Solo Ida",cat:"Traslados"},{id:"ida_retorno",label:"⇄ Ida y Retorno",cat:"Traslados"},{id:"ida_retorno_paradas",label:"📍 Con Paradas",cat:"Disposición"},{id:"full_day",label:"⭐ Full Day",cat:"Turismo"},{id:"multi_dia",label:"🏕️ Multi-día",cat:"Turismo"}];
const SERVS_FIJO=[{id:"fijo_solo_ida",label:"→ Solo Ida",cat:"Ruta Simple"},{id:"transporte_personal",label:"⇄ Ida y Retorno",cat:"Ruta Simple"},{id:"fijo_multiparada",label:"📍 Con Paraderos",cat:"Ruta Logística"},{id:"fijo_reten",label:"🏭 Retén / Planta",cat:"Retén"}];
const ESTADO_CFG:Record<EstadoCot,{label:string;bg:string;color:string}>={borrador:{label:"Borrador",bg:"#f3f4f6",color:"#6b7280"},pendiente:{label:"Pendiente",bg:"#fef9c3",color:"#854d0e"},enviado:{label:"Enviado",bg:"#e0f2fe",color:"#0369a1"},aprobado:{label:"Aprobado",bg:"#dcfce7",color:"#166534"},rechazado:{label:"Rechazado",bg:"#fee2e2",color:"#991b1b"}};
const TRANSICIONES:Record<EstadoCot,EstadoCot[]>={borrador:["pendiente"],pendiente:["enviado"],enviado:["aprobado","rechazado"],aprobado:[],rechazado:["pendiente"]};
const TIPOS_APROBACION=["Operación bancaria","Orden de compra","Orden de servicio","Correo de confirmación","Contrato firmado"];
const ITEM_VACIO:ItemCot={descripcion:"",dias:1,cantidad:1,precio_unit:0,descuento_pct:0,pax_contratado:null};
const FORM0={cliente_id:"",origen:"",destino:"",km:"",costo_estimado:"",estado:"pendiente" as EstadoCot,numero_cotizacion:"",atencion:"",asunto:"",punto_retorno:"",fecha_servicio:"",fecha_retorno:"",hora_ida:"",hora_retorno:"",descuento_pct:"0",tipo_vehiculo:"",equipamiento:"full_equipo",vehiculo_flota_id:"",vehiculo_tercero_id:"",modo_servicio:"eventual" as ModoServ,tipo_servicio:"solo_ida",dias_servicio:"1",horas_servicio:"8",pernocte_costo:"0",precio_dia:"",incluye_igv:true,itinerario_texto:"",moneda:"PEN" as Moneda,tipo_cambio:"",idioma_pdf:"es" as Idioma};

const fmtS=(n:number)=>`S/ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtF=(f:string|null)=>f?new Date(f+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}):"—";
/** Un importe ya expresado en `m` (S/ o US$). */
const fmtM=(n:number,m:Moneda)=>m==="USD"?`US$ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`:fmtS(n);
/**
 * Un importe GUARDADO en soles, enseñado en la moneda de la cotización. Sin un tipo de cambio
 * válido se enseña en soles (nunca soles rotulados como dólares).
 */
const fmtCot=(pen:number,m:Moneda,tc:unknown)=>{const v=aMonedaCot(pen,m,tc);return v==null?fmtS(pen):fmtM(v,m);};
/** El `title` de un importe en dólares: lo que vale en soles y a qué tipo de cambio. */
const tituloSoles=(pen:number,m:Moneda,tc:unknown)=>m==="USD"?`${fmtS(pen)} al tipo de cambio ${revisarTipoCambio(tc).tc??"—"} (se guarda en soles)`:undefined;
const norm=(s:string)=>s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const iCls=(e="")=>`w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${e}`;
function extraerNombreApellido(nombre:string):string{const p=nombre.toUpperCase().trim().split(/\s+/).filter(Boolean);if(p.length===0)return nombre.toUpperCase();if(p.length<=2)return p.join(" ");if(p.length===3)return p[0]+" "+p[1];return p[0]+" "+p[2];}
const enHorario=()=>{const l=new Date(new Date().toLocaleString("en-US",{timeZone:"America/Lima"}));return l.getDay()>=1&&l.getDay()<=5&&l.getHours()>=8&&l.getHours()<18;};
const GRUPO_COLOR:{[k:string]:{color:string;bg:string}}={Ligeros:{color:"#6366f1",bg:"#eef2ff"},Vans:{color:"#0891b2",bg:"#ecfeff"},Buses:{color:"#0b315f",bg:"#eef3f8"},Otros:{color:"#6b7280",bg:"#f3f4f6"}};

function Campo({label,span,req,hint,extra,children}:{label:string;span?:number;req?:boolean;hint?:string;extra?:React.ReactNode;children:React.ReactNode}){
  return(<div className={span===2?"md:col-span-2":span===3?"md:col-span-3":""}><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}{req&&<span className="text-red-400 ml-0.5">*</span>}{extra}</label>{children}{hint&&<p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}</div>);
}

function calcCostoVeh(p:ParamCosto,pr:Record<string,number>,km:number,dias:number,peajes:number,pernocte:number,viaticos:number){
  // Los seis términos del S/km salen de lib/costos/costo-km-parametro.ts, que es donde vive
  // ahora la fórmula. Lo que NO se toca es el AGRUPAMIENTO de esta suma: en coma flotante,
  // reordenar los mismos términos puede mover el último decimal, y de aquí sale un precio.
  const c=componentesCostoKm(p,pr);
  const sub=((c.combustible+c.urea)*km)+c.neumaticos*km+c.mantenimiento*km+c.depreciacion*km+c.fijos*km;
  const total=(sub+sub*RESERVA)+p.conductor_dia*dias+peajes;
  const base=total+total*OVERHEAD+pernocte+viaticos;
  const pF=(m:number)=>base/(1-m);const fF=(m:number)=>pF(m)*(1+IGV);
  return{baseCosto:base,totalMin15:fF(0.15),totalEst20:fF(0.20),totalAlto25:fF(0.25),sinIGV15:pF(0.15),sinIGV20:pF(0.20),sinIGV25:pF(0.25),precioPax20:fF(0.20)/(p.capacidad||1),precioPax20Sin:pF(0.20)/(p.capacidad||1),diaEstIGV:fF(0.20),diaMinIGV:fF(0.15),mesEstIGV:fF(0.20)*26};
}

function SugerenciaEnVivo({origen,destino,tipoVehId,tipoServ,equip,km,dias,peajes,pernocte,viaticos,modoServ,tarifas,paramsDB,preciosDB,onAplicar,moneda="PEN",tc=null}:{origen:string;destino:string;tipoVehId:string;tipoServ:string;equip:string;km:number;dias:number;peajes:number;pernocte:number;viaticos:number;modoServ:ModoServ;tarifas:Tarifa[];paramsDB:ParamCosto[];preciosDB:Record<string,number>;onAplicar:(sinIGV:number,fuente:string,costo?:number)=>void;moneda?:Moneda;tc?:unknown;}){
  // Todo se calcula en SOLES (como se guarda); en una cotización en dólares se ENSEÑA en US$ al
  // tipo de cambio de la cotización, con los soles en el title. `onAplicar` recibe siempre soles.
  const usd=moneda==="USD"&&revisarTipoCambio(tc).codigo==="ok";
  const M=(pen:number)=>usd?fmtCot(pen,"USD",tc):fmtS(pen);
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
          <span className="px-2 py-0.5 rounded-lg text-[9px] font-black bg-white/10 text-white/60 uppercase tracking-wider">Precios sin IGV{usd?" · en US$":""}</span>
          <div className={`px-3 py-1 rounded-xl text-[11px] font-bold ${enOf?"bg-green-500/20 text-green-300":"bg-amber-500/20 text-amber-300"}`}>{enOf?"🟢 Horario oficina":"🟡 Fuera horario"}</div>
        </div>
      </div>
      <div className="px-5 pb-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {/* Mínimo 15% */}
          <div className="rounded-xl bg-red-500/10 border border-red-400/20 p-3">
            <p className="text-[9px] font-black text-red-300 uppercase mb-1">⛔ Mínimo 15%</p>
            {km>0&&costo?(<>
              <p className="font-black text-lg text-white font-mono">{M(dispMin)}</p>
              <p className="text-[9px] text-red-300/60 mb-1">+IGV → {M(dispMin*1.18)}</p>
              <button onClick={()=>onAplicar(dispMin,"cotizador_min",costo.baseCosto)} className="w-full py-1 rounded-lg text-[10px] font-black text-white bg-red-500/30 hover:bg-red-500/50">Usar mínimo</button>
            </>):<p className="text-white/25 text-xs mt-1">Ingresa km</p>}
          </div>
          {/* Estándar 20% */}
          <div className="rounded-xl bg-blue-500/15 border-2 border-blue-400/40 p-3 relative">
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[8px] font-black px-2 py-0.5 rounded-full whitespace-nowrap">RECOMENDADO</div>
            <p className="text-[9px] font-black text-blue-300 uppercase mb-1">🔧 Estándar 20%</p>
            {km>0&&costo?(<>
              <p className="font-black text-lg text-white font-mono">{M(dispEst)}</p>
              <p className="text-[9px] text-blue-300/70">{esFijo?`~${M(dispEst*26)}/mes`:`${M(costo.precioPax20Sin)}/pax`}</p>
              <button onClick={()=>onAplicar(dispEst,"cotizador",costo.baseCosto)} className="mt-2 w-full py-1 rounded-lg text-[10px] font-black text-white bg-blue-500 hover:bg-blue-400">✓ Usar estándar</button>
            </>):<p className="text-white/25 text-xs mt-1">Ingresa km</p>}
          </div>
          {/* Tarifario */}
          <div className={`rounded-xl p-3 border ${tarifaExacta?"bg-green-500/15 border-green-400/40":"bg-white/8 border-white/15"}`}>
            {tarifaExacta?(<>
              <p className="text-[9px] font-black text-green-300 uppercase mb-1">📋 Tarifario</p>
              <p className="font-black text-lg text-white font-mono">{M(dispTarif)}</p>
              <p className="text-[9px] text-green-300/60 mb-1">+IGV → {M(dispTarif*1.18)}</p>
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
            <p className="text-white font-black text-xl font-mono" title={tituloSoles(dispSug,moneda,tc)}>{M(dispSug)}</p>{usd&&<p className="text-white/40 text-[10px] font-mono">= {fmtS(dispSug)} sin IGV (se guarda en soles)</p>}
            <p className="text-white/40 text-[10px]">Con IGV → {M(dispSug*1.18)}{esFijo&&costo?`  ·  ~${M(dispSug*26)}/mes s/IGV`:""}</p>
          </div>
          <button onClick={()=>onAplicar(dispSug,"sugerido",costo?.baseCosto)} className="px-4 py-2.5 rounded-xl font-black text-sm bg-white text-[#0b315f] hover:bg-gray-100 flex-shrink-0">→ Aplicar</button>
        </div>)}
      </div>
    </div>
  );
}

function PanelDecision({c,onAct}:{c:CotFila;onAct:()=>void}){
  const [guardando,setGuardando]=useState(false);const [descPct,setDescPct]=useState(c.descuento_pct_solicitado?.toString()||"");
  // Los importes de la fila son SOLES (y así se escriben); en una cotización en dólares se ENSEÑAN
  // en US$ al tipo de cambio congelado en ella.
  const mon=normalizarMoneda(c.moneda);const fmtC=(pen:number)=>fmtCot(pen,mon,c.tipo_cambio);
  const enOf=enHorario();if(!c.precio_cotizador&&!c.precio_tarifario)return null;
  const esFijo=c.modo_servicio==="fijo";const tarifIGV=c.precio_tarifario?c.precio_tarifario*1.18:null;const precSug=Math.max(c.precio_cotizador||0,tarifIGV||0)||Number(c.precio_cliente);const precDesc=c.descuento_pct_solicitado?precSug*(1-c.descuento_pct_solicitado/100):null;const fuente=c.precio_cotizador&&tarifIGV?(c.precio_cotizador>=tarifIGV?"Cotizador":"Tarifario"):c.precio_cotizador?"Cotizador":"Tarifario";
  async function getCosto(){const{data}=await supabase.from("cotizaciones").select("costo_estimado").eq("id",c.id).single();return Number(data?.costo_estimado||0);}
  async function aplicar(precio:number,modo:string){setGuardando(true);const costo=await getCosto();await supabase.from("cotizaciones").update({precio_cliente:precio,margen_estimado:precio-costo,precio_sugerido:precSug,modo_precio:modo,enviado_automatico:!enOf}).eq("id",c.id);setGuardando(false);onAct();}
  async function solDesc(){const pct=parseFloat(descPct);if(!pct||pct<=0||pct>=100)return;setGuardando(true);await supabase.from("cotizaciones").update({descuento_solicitado:true,descuento_pct_solicitado:pct,descuento_autorizado:false,hora_solicitud_descuento:new Date().toISOString()}).eq("id",c.id);setGuardando(false);onAct();}
  async function autDesc(){if(!precDesc)return;setGuardando(true);const costo=await getCosto();await supabase.from("cotizaciones").update({precio_cliente:precDesc,margen_estimado:precDesc-costo,descuento_autorizado:true,modo_precio:"descuento_autorizado"}).eq("id",c.id);setGuardando(false);onAct();}
  async function rechDesc(){setGuardando(true);await supabase.from("cotizaciones").update({descuento_autorizado:false,descuento_solicitado:false}).eq("id",c.id);setGuardando(false);onAct();}
  return(<div className="mt-2 rounded-xl border overflow-hidden" style={{borderColor:"#0b315f22"}}><div className="px-3 py-2 flex items-center gap-2 flex-wrap" style={{background:"#eef3f8"}}><span className="text-[11px] font-black text-[#0b315f]">💡 Precios{esFijo?" · FIJO":""}</span>{mon==="USD"&&<span className="text-[10px] bg-sky-50 text-sky-800 border border-sky-200 font-bold px-1.5 py-0.5 rounded-full" title="Los importes se guardan en soles; aquí se enseñan en dólares al tipo de cambio de la cotización.">US$ al TC {revisarTipoCambio(c.tipo_cambio).tc??"—"} · se guarda en soles</span>}{c.precio_cotizador&&<span className="text-[10px] bg-blue-100 text-blue-700 font-bold px-1.5 py-0.5 rounded-full">🔧 {fmtC(c.precio_cotizador)}{esFijo?"/día":""}</span>}{tarifIGV&&<span className="text-[10px] bg-green-100 text-green-700 font-bold px-1.5 py-0.5 rounded-full">📋 {fmtC(tarifIGV)}{esFijo?"/día":""}</span>}<span className="text-[10px] bg-[#0b315f] text-white font-bold px-1.5 py-0.5 rounded-full">⭐ {fmtC(precSug)} ({fuente})</span>{c.descuento_solicitado&&!c.descuento_autorizado&&<span className="text-[10px] bg-orange-100 text-orange-700 font-bold px-1.5 py-0.5 rounded-full animate-pulse">🙋 {c.descuento_pct_solicitado}% pendiente</span>}{esFijo&&c.precio_mes_estimado&&<span className="text-[10px] bg-green-50 text-green-700 font-bold px-1.5 py-0.5 rounded-full">📅 ~{fmtC(c.precio_mes_estimado)}/mes</span>}</div><div className="p-3 bg-white space-y-3">{!enOf&&<div className="rounded-xl px-3 py-2 border border-amber-200 bg-amber-50 text-xs text-amber-800 font-semibold">⏰ Fuera de horario L-V 8-18h — precio máximo sugerido automáticamente</div>}{c.descuento_solicitado&&!c.descuento_autorizado&&(<div className="rounded-xl border-2 border-orange-300 bg-orange-50 p-3"><p className="font-black text-orange-800 text-sm mb-2">🙋 Descuento {c.descuento_pct_solicitado}% → {precDesc?fmtC(precDesc):"—"}</p>{enOf?<div className="flex gap-2"><button onClick={autDesc} disabled={guardando} className="flex-1 py-1.5 rounded-xl font-black text-xs text-white bg-green-600 disabled:opacity-50">✅ Autorizar</button><button onClick={rechDesc} disabled={guardando} className="px-3 py-1.5 rounded-xl font-bold text-xs border border-red-200 text-red-600 disabled:opacity-50">✕</button></div>:<p className="text-orange-600 text-xs font-bold text-center bg-orange-100 rounded-lg py-1.5">⏰ Se responderá en horario de oficina</p>}</div>)}<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{[{label:"🔧 Cotizador",val:c.precio_cotizador,color:"blue",modo:"cotizador"},{label:"📋 Tarifario",val:tarifIGV,color:"green",modo:"tarifario"},{label:"⭐ Sugerido",val:precSug,color:"navy",modo:"sugerido"}].map(item=>(<div key={item.label} className={`rounded-xl border-2 p-2.5 ${item.color==="blue"?"border-blue-200 bg-blue-50":item.color==="green"?"border-green-200 bg-green-50":"border-[#0b315f] bg-[#eef3f8]"}`}><p className={`text-[9px] font-bold uppercase mb-1 ${item.color==="blue"?"text-blue-600":item.color==="green"?"text-green-600":"text-[#0b315f]"}`}>{item.label}</p><p className={`font-black text-sm font-mono ${item.color==="blue"?"text-blue-700":item.color==="green"?"text-green-700":"text-[#0b315f]"}`}>{item.val?fmtC(item.val):"—"}</p>{esFijo&&item.val&&<p className="text-[9px] text-gray-400">~{fmtC(item.val*26)}/mes</p>}{item.val&&enOf&&<button onClick={()=>aplicar(item.val!,item.modo)} disabled={guardando||Math.abs(Number(c.precio_cliente)-item.val)<0.01} className={`mt-1.5 w-full py-1 rounded-lg text-[10px] font-black text-white disabled:opacity-40 ${item.color==="blue"?"bg-blue-600":item.color==="green"?"bg-green-600":"bg-[#0b315f]"}`}>{Math.abs(Number(c.precio_cliente)-item.val)<0.01?"✓":"Usar"}</button>}</div>))}</div><div className="flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2"><div><p className="text-[10px] text-gray-400 font-bold uppercase">Precio actual</p><p className="font-black text-sm text-gray-800">{fmtC(Number(c.precio_cliente))}{esFijo&&<span className="text-[10px] text-gray-400 font-normal ml-1">/día</span>}</p></div><p className="text-[10px] text-gray-400">Modo: <b>{c.modo_precio||"manual"}</b></p></div>{!c.descuento_solicitado&&!c.descuento_autorizado&&(<div className="border border-dashed border-gray-200 rounded-xl p-2.5"><p className="text-[9px] font-bold text-gray-400 uppercase mb-1.5">🙋 Registrar descuento</p><div className="flex gap-2"><input type="number" min={1} max={50} placeholder="%" value={descPct} onChange={e=>setDescPct(e.target.value)} className="flex-1 border border-gray-200 rounded-xl px-2.5 py-1.5 text-sm outline-none focus:border-[#0b315f]"/><button onClick={solDesc} disabled={guardando||!descPct} className="px-3 py-1.5 rounded-xl font-bold text-xs text-white bg-orange-500 hover:bg-orange-600 disabled:opacity-40">Registrar</button></div></div>)}</div></div>);
}

const MEDIOS_ENVIO=[{id:"WhatsApp",icon:"💬"},{id:"Correo electrónico",icon:"✉️"},{id:"Otros medios",icon:"📋"}];

function ModalEliminar({cot,onConfirmar,onCancelar}:{cot:CotFila;onConfirmar:(pass:string)=>Promise<string|null>;onCancelar:()=>void}){
  const[pass,setPass]=useState("");const[err,setErr]=useState("");const[cargando,setCargando]=useState(false);
  const intentar=async()=>{if(!pass){setErr("Ingresa tu contraseña");return;}setCargando(true);setErr("");const r=await onConfirmar(pass);setCargando(false);if(r)setErr(r);};
  return(<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"><div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm"><div className="text-center mb-5"><div className="text-4xl mb-2">🗑️</div><h3 className="text-lg font-black text-gray-800">Eliminar cotización</h3><p className="text-sm text-gray-500 mt-1 font-mono font-bold">#{cot.numero_cotizacion||String(cot.id).padStart(5,"0")}</p><p className="text-xs text-red-600 font-bold mt-2">Esta acción no se puede deshacer</p></div><div className="mb-4"><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Contraseña de administrador</label><input type="password" value={pass} onChange={e=>{setPass(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&intentar()} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 transition-all" placeholder="••••••••" autoFocus/>{err&&<p className="text-xs text-red-600 mt-1.5 font-medium">⚠️ {err}</p>}</div><div className="flex gap-2"><button onClick={onCancelar} className="flex-1 py-2.5 rounded-xl text-sm font-bold border hover:bg-gray-50 text-gray-700">Cancelar</button><button onClick={intentar} disabled={cargando} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{background:"#dc2626"}}>{cargando?"Verificando...":"🗑️ Eliminar"}</button></div></div></div>);
}

function ModalEnvio({onConfirmar,onCancelar,ocupado=false}:{onConfirmar:(medio:string)=>void;onCancelar:()=>void;ocupado?:boolean}){
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
          <button onClick={confirmar} disabled={ocupado} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{background:"#0b315f"}}>{ocupado?"⏳ Guardando…":"✅ Confirmar envío"}</button>
          <button onClick={onCancelar} disabled={ocupado} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50 disabled:opacity-50">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function ModalAprobacion({cot,onConfirmar,onCancelar,ocupado=false}:{cot:CotFila;onConfirmar:(tipo:string,numero:string)=>void;onCancelar:()=>void;ocupado?:boolean}){
  const [tipo,setTipo]=useState("Operación bancaria");const [num,setNum]=useState("");const [err,setErr]=useState("");
  return(<div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{background:"rgba(0,0,0,0.5)"}}><div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"><h3 className="text-base font-bold">✅ Aprobar cotización #{cot.numero_cotizacion||cot.id}</h3><div><label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">Tipo de documento *</label><select className={iCls()} value={tipo} onChange={e=>setTipo(e.target.value)}>{TIPOS_APROBACION.map(t=><option key={t}>{t}</option>)}</select></div><div><label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">N° referencia *</label><input className={iCls("font-mono")} placeholder="Número o código" value={num} onChange={e=>{setNum(e.target.value);setErr("");}} autoFocus/>{err&&<p className="text-xs text-red-600 mt-1">⚠ {err}</p>}</div><div className="flex gap-3"><button onClick={()=>num.trim()?onConfirmar(tipo,num.trim()):setErr("Obligatorio")} disabled={ocupado} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-green-700 disabled:opacity-60">{ocupado?"⏳ Guardando…":"✅ Confirmar"}</button><button onClick={onCancelar} disabled={ocupado} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 disabled:opacity-50">Cancelar</button></div></div></div>);
}

/** Acciones de la fila que ESCRIBEN en la base: su bandera dura hasta que terminan (ver conDetalle). */
const ACCIONES_QUE_ESCRIBEN=new Set(["duplicar","reserva"]);

/**
 * Cómo se pinta cada DISEÑO en las listas de plantillas (la plantilla elige su icono; si no, el del
 * diseño). La lista de plantillas viene de la base (lib/cotizacion-plantillas-datos.ts): antes era
 * una lista fija de cuatro en el código, y una plantilla duplicada no se podía elegir.
 */
const ESTILO_DISENO:Record<Diseno,{icon:string;color:string;bg:string}>={
  corporativo:{icon:"🏢",color:"#0b315f",bg:"#eef3f8"},
  moderno_fotos:{icon:"📸",color:"#1a1a2e",bg:"#f0f4ff"},
  turistico:{icon:"🌄",color:"#b45309",bg:"#fffbeb"},
  ejecutivo:{icon:"⭐",color:"#1a1a1a",bg:"#fafafa"},
};
/**
 * Las plantillas que se pueden elegir: las ACTIVAS, más las de `incluir` aunque estén desactivadas
 * (la que ya tiene la cotización: elegirla de nuevo no puede ser imposible) y, si la lista no se
 * pudo leer, un renglón con su id — nunca una lista vacía.
 */
function opcionesPlantilla(plantillas:readonly PlantillaFila[],incluir:readonly (string|null|undefined)[]):PlantillaFila[]{
  const ids=new Set(incluir.filter((x):x is string=>!!x));
  const out=plantillas.filter(p=>esActiva(p)||ids.has(p.id));
  for(const id of ids)if(!out.some(p=>p.id===id))out.push({id,nombre:id});
  return out;
}
const rotuloOpcion=(p:PlantillaFila)=>`${p.icono||ESTILO_DISENO[disenoDe(p)].icon} ${p.nombre||p.id} · ${ETIQUETA_DISENO[disenoDe(p)]}${p.es_principal?" · principal":""}${esActiva(p)?"":" · desactivada"}`;

/**
 * `avisos` = lo que `htmlCotizacion` (lib/cotizacion-pdf.ts) dice de ESTA combinación de
 * plantilla, idioma y moneda; null mientras se comprueba (no se afirma «sin avisos» buscando).
 * Solo un aviso que `bloquea` (dólares sin tipo de cambio) apaga el botón, y lo dice debajo.
 */
function ModalPlantilla({cot,plantillas,errorPlantillas,plantillaActual,onElegir,idioma,onIdioma,avisos,errorAvisos,generando=false,onGenerar,onCancelar}:{cot:Cotizacion;plantillas:PlantillaFila[];errorPlantillas?:string|null;plantillaActual:string;onElegir:(id:string)=>void;idioma:Idioma;onIdioma:(i:Idioma)=>void;avisos:AvisoPdf[]|null;errorAvisos?:string;generando?:boolean;onGenerar:()=>void;onCancelar:()=>void;}){
  const bloqueo=avisos?.find(a=>a.bloquea)||null;
  const mon=normalizarMoneda(cot.moneda);
  // Las activas y la que tiene la cotización aunque esté desactivada (ver opcionesPlantilla).
  const opciones=opcionesPlantilla(plantillas,[cot.plantilla_pdf||"corporativo",plantillaActual]);
  return(
    <div style={{position:"fixed",inset:0,zIndex:60,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px",background:"rgba(0,0,0,0.55)"}}>
      <div style={{background:"white",borderRadius:24,boxShadow:"0 24px 60px rgba(0,0,0,0.2)",width:"100%",maxWidth:520,padding:28}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div><p style={{fontWeight:900,fontSize:17,color:"#1e293b",margin:0}}>📄 Elegir plantilla PDF</p><p style={{color:"#94a3b8",fontSize:12,margin:"3px 0 0"}}>Cotización #{cot.numero_cotizacion||cot.id}</p></div>
          <button onClick={onCancelar} style={{background:"#f1f5f9",border:"none",borderRadius:10,width:32,height:32,cursor:"pointer",fontSize:16,color:"#64748b"}}>✕</button>
        </div>
        {errorPlantillas&&<p style={{fontSize:11,color:"#92400e",background:"#fffbeb",border:"1px solid #fcd34d",borderRadius:10,padding:"6px 10px",margin:"0 0 12px"}}>⚠ {errorPlantillas}{plantillas.length===0?" Se ofrecen solo la de esta cotización y la corporativa.":""}</p>}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20,maxHeight:"50vh",overflowY:"auto",padding:2}}>
          {opciones.map(p=>{
            const sel=plantillaActual===p.id;
            const d=disenoDe(p);const est=ESTILO_DISENO[d];
            const activa=esActiva(p);
            return(
              <button key={p.id} onClick={()=>onElegir(p.id)} title={activa?undefined:"Desactivada: no se ofrece en cotizaciones nuevas, pero esta cotización la tiene elegida."} style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:6,padding:"14px 16px",borderRadius:16,border:`2px solid ${sel?est.color:"#e2e8f0"}`,background:sel?est.bg:"white",cursor:"pointer",textAlign:"left",transition:"all 0.15s",boxShadow:sel?"0 0 0 3px "+est.color+"22":"none",opacity:activa?1:0.75}}>
                <div style={{display:"flex",alignItems:"center",gap:8,width:"100%"}}>
                  <span style={{fontSize:22}}>{p.icono||est.icon}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{fontWeight:900,fontSize:13,color:sel?est.color:"#1e293b",margin:0}}>{p.nombre||p.id}</p>
                    <p style={{color:"#94a3b8",fontSize:11,margin:"1px 0 0"}}>Diseño {ETIQUETA_DISENO[d]}</p>
                  </div>
                  {p.es_principal&&<span style={{fontSize:9,fontWeight:900,background:est.color,color:"white",padding:"2px 7px",borderRadius:20,flexShrink:0}}>PRINCIPAL</span>}
                  {!activa&&<span style={{fontSize:9,fontWeight:900,background:"#e2e8f0",color:"#475569",padding:"2px 7px",borderRadius:20,flexShrink:0}}>DESACTIVADA</span>}
                </div>
                {sel&&<span style={{fontSize:10,fontWeight:800,color:est.color}}>✓ Seleccionada</span>}
              </button>
            );
          })}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
          <span style={{fontSize:11,fontWeight:800,color:"#64748b",textTransform:"uppercase"}}>Idioma del PDF</span>
          {(["es","en"] as Idioma[]).map(i=>(
            <button key={i} onClick={()=>onIdioma(i)} style={{padding:"6px 12px",borderRadius:10,border:`2px solid ${idioma===i?"#0b315f":"#e2e8f0"}`,background:idioma===i?"#eef3f8":"white",color:idioma===i?"#0b315f":"#64748b",fontWeight:800,fontSize:12,cursor:"pointer"}}>{i==="es"?"🇵🇪 Español":"🇺🇸 English"}</button>
          ))}
          <span style={{fontSize:11,color:"#94a3b8"}}>Moneda: <b>{mon==="USD"?`US$ (TC ${revisarTipoCambio(cot.tipo_cambio).tc??"—"})`:"S/"}</b></span>
        </div>
        {avisos===null&&!errorAvisos&&<p style={{fontSize:11,color:"#94a3b8",margin:"0 0 12px"}}>Comprobando la plantilla, las cuentas bancarias y el idioma…</p>}
        {errorAvisos&&<p style={{fontSize:11,color:"#92400e",background:"#fffbeb",border:"1px solid #fcd34d",borderRadius:10,padding:"6px 10px",margin:"0 0 12px"}}>⚠ No se pudo comprobar la plantilla: {errorAvisos}</p>}
        {avisos&&avisos.length>0&&<div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
          {avisos.map(a=>(
            <p key={a.codigo} style={{fontSize:11,margin:0,borderRadius:10,padding:"6px 10px",...(a.bloquea?{color:"#991b1b",background:"#fef2f2",border:"1px solid #fca5a5"}:{color:"#92400e",background:"#fffbeb",border:"1px solid #fcd34d"})}}>{a.bloquea?"⛔":"⚠"} {a.detalle}</p>
          ))}
        </div>}
        <div style={{display:"flex",gap:10}}>
          <button onClick={onGenerar} disabled={!!bloqueo||generando} style={{flex:1,padding:"12px",borderRadius:14,border:"none",background:"#0b315f",color:"white",fontWeight:900,fontSize:14,cursor:bloqueo||generando?"not-allowed":"pointer",opacity:bloqueo||generando?0.5:1}}>
            {generando?"⏳ Generando…":"📄 Generar PDF"}
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
// `marca` = estadoMarca(p, firma) de lib/paradas-horario.ts: la pantalla solo la rotula.
function CardParada({ p, lbl, col, onUpd, onSel, onDel, mapsLoaded, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isOver, marca, aviso, renombre, onVolverNombre, onReintentarDireccion }: {
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
  marca?: "manual" | "vigente" | "desactualizada";
  aviso?: string;
  /** Se arrastró en el mapa: su dirección se busca sola (ver AvisoRenombreMapa). */
  renombre?: RenombreMapa;
  onVolverNombre?: () => void;
  onReintentarDireccion?: () => void;
}) {
  const inp = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f] bg-white";
  const hc = p.hora_calc;
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
        <div className="min-w-0">
          <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Lugar</label>
          {mapsLoaded ? (
            <LocationInputCot placeholder={p.tipo==="intermedia"?"Buscar parada…":"Nombre del punto"} value={p.nombre} mapsLoaded={mapsLoaded}
              onChange={v => onUpd(p.id, "nombre", v)}
              onSelect={r => onSel(p.id, r)} />
          ) : (
            <input className={inp} value={p.nombre} onChange={e => onUpd(p.id, "nombre", e.target.value)} placeholder="—" />
          )}
          {p.lat && p.lng && (
            <p className="text-[9px] text-gray-300 mt-1 font-mono break-all">
              📍 <a href={urlMapsPunto(p.lat, p.lng)} target="_blank" rel="noreferrer" className="hover:text-blue-500 hover:underline">{fmtCoord(p.lat, p.lng)}</a>
            </p>
          )}
          {onVolverNombre && onReintentarDireccion && (
            <AvisoRenombreMapa estado={renombre} onVolver={onVolverNombre} onReintentar={onReintentarDireccion} />
          )}
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Hora</label>
          <input type="time" className={inp} value={p.hora} onChange={e => onUpd(p.id, "hora", e.target.value)} />
          {hc && marca === "vigente" && (
            <span className="inline-block mt-1 text-[9px] font-bold rounded-full px-1.5 py-0.5 bg-sky-50 text-sky-800 border border-sky-200"
              title={hc.modo === "trafico" ? `Calculada con el tráfico previsto del ${etiquetaDiaCorta(hc.fecha_ref)} (Google, best_guess) y ${hc.espera_min} min de embarque por paradero.` : `Calculada con la ruta sin tráfico y ${hc.espera_min} min de embarque por paradero.`}>
              {hc.modo === "trafico" ? `🚦 previsto ${etiquetaDiaCorta(hc.fecha_ref)}` : "≈ sin tráfico"}{hc.dia === 1 ? " (+1)" : ""}
            </span>
          )}
          {hc && marca === "desactualizada" && (
            <span className="inline-block mt-1 text-[9px] font-bold rounded-full px-1.5 py-0.5 bg-amber-50 text-amber-800 border border-amber-300"
              title="La hora se calculó con otros paraderos. «Calcular horas» respeta las horas escritas: usa «Recalcular todas» para rehacerla.">
              ⚠ desactualizada (moviste un paradero){hc.dia === 1 ? " (+1)" : ""}
            </span>
          )}
        </div>
        {aviso && <p className="col-span-2 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">⚠ {aviso}</p>}
      </div>
    </div>
  );
}

/** Inicio, intermedios en su orden, destino: el orden del recorrido (y de la ruta y las horas). */
function ordenarParadas(ps: ParadaTP[]): ParadaTP[] {
  const ini = ps.find(p => p.tipo === "inicio");
  const fin = ps.find(p => p.tipo === "destino");
  return [...(ini ? [ini] : []), ...ps.filter(p => p.tipo === "intermedia"), ...(fin ? [fin] : [])];
}

/**
 * La dirección de un punto (Google, por el servidor). Una sola consulta por punto: arrastrar el
 * paradero 1 renombra a la vez el paradero y el «Punto de origen», y los dos piden lo mismo.
 * Un fallo no se recuerda (el reintento vuelve a consultar).
 */
const direccionesPedidas = new Map<string, Promise<string | null>>();
function direccionDePunto(lat: number, lng: number): Promise<string | null> {
  const clave = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const ya = direccionesPedidas.get(clave);
  if (ya) return ya;
  const p = (async () => {
    const r = await fetch("/api/geocodificar-inverso", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat, lng }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
    return typeof d?.direccion === "string" && d.direccion.trim() ? d.direccion.trim() : null;
  })();
  direccionesPedidas.set(clave, p);
  p.catch(() => direccionesPedidas.delete(clave));
  return p;
}

/** Lo que pasó con el nombre de un punto arrastrado en el mapa. */
type RenombreMapa = { cargando?: boolean; error?: string; anterior?: string; puesto?: string };

/**
 * Debajo del nombre de un punto arrastrado: buscando, el error con su reintento, o la dirección
 * nueva con la vuelta al nombre de antes (un «Punta Hermosa» escrito a mano no se pierde por
 * mover el marcador unos metros).
 */
function AvisoRenombreMapa({ estado, onVolver, onReintentar }: { estado?: RenombreMapa; onVolver: () => void; onReintentar: () => void }) {
  if (!estado) return null;
  if (estado.cargando) return <p className="mt-1 text-[10px] text-gray-400">⏳ Buscando la dirección del punto que moviste…</p>;
  if (estado.error) return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="text-[10px] text-red-600">⚠ {estado.error}</span>
      <button type="button" onClick={onReintentar} className="text-[10px] font-bold text-[#0b315f] border border-[#0b315f]/30 rounded-lg px-2 py-0.5 hover:bg-blue-50">↻ Reintentar</button>
    </div>
  );
  if (estado.puesto && estado.anterior?.trim()) return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="text-[10px] text-sky-700">📍 Dirección tomada del mapa.</span>
      <button type="button" onClick={onVolver} className="text-[10px] font-bold text-[#0b315f] hover:underline">↩ Volver a «{estado.anterior}»</button>
    </div>
  );
  return null;
}

function ParadasBuilder({ paradas, onChange, tipo = "solo_ida", mapsLoaded, origenNombre, destinoNombre, origenLat, origenLng, destinoLat, destinoLng, horaIda, horaRetorno, contexto, onMoverExtremo }: {
  paradas: ParadaTP[]; onChange: (p: ParadaTP[]) => void; tipo?: string;
  mapsLoaded?: boolean; origenNombre?: string; destinoNombre?: string;
  origenLat?: string; origenLng?: string; destinoLat?: string; destinoLng?: string;
  horaIda?: string; horaRetorno?: string;
  /** Para «⏱ Calcular horas»: modo y fecha del servicio, sentido y salidas. */
  contexto?: ContextoHoras;
  /** El paradero 1 o el último se arrastró en el mapa (solo la ida: los ata al origen/destino del formulario). */
  onMoverExtremo?: (tipo: "inicio" | "destino", lat: number, lng: number) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const droppedRef = useRef(false);

  // ── Ruta, mapa y horas ──────────────────────────────────────────────────────
  const ord = useMemo(() => ordenarParadas(paradas), [paradas]);
  const ruta = useRutaParaderos(ord);
  const firmaActual = firmaParaderos(ord);
  const [verMapa, setVerMapa] = useState(true);
  const [avisos, setAvisos] = useState<{ firma: string; porId: Record<string, string> }>({ firma: "", porId: {} });
  const [renombres, setRenombres] = useState<Record<string, RenombreMapa>>({});
  // Lo que se lee DESPUÉS de un await (geocodificar, insertar): la lista de ahora, no la del clic.
  const vivo = useRef({ paradas, onChange });
  useEffect(() => { vivo.current = { paradas, onChange }; }, [paradas, onChange]);

  const nId = () => Math.random().toString(36).slice(2, 8);
  const olvidarRenombre = (id: string) => setRenombres(prev => { if (!prev[id]) return prev; const n = { ...prev }; delete n[id]; return n; });
  const upd = (id: string, k: keyof ParadaTP, v: string) => {
    onChange(paradas.map(p => p.id === id ? { ...p, [k]: v } : p));
    // Quien escribe el nombre decide: la vuelta al anterior ya no aplica.
    if (k === "nombre") olvidarRenombre(id);
  };
  // Actualización atómica de nombre+lat+lng para evitar stale closure con 3 setState seguidos
  const sel = (id: string, r: PlaceResultCot) => {
    onChange(paradas.map(p => p.id === id ? { ...p, nombre: r.address, lat: String(r.lat), lng: String(r.lng) } : p));
    olvidarRenombre(id);
  };
  const inicio = paradas.find(p => p.tipo === "inicio");
  const fin    = paradas.find(p => p.tipo === "destino");
  const meds   = paradas.filter(p => p.tipo === "intermedia");
  const addMed = () => {
    const n: ParadaTP = { id: nId(), tipo: "intermedia", nombre: "", direccion: "", lat: "", lng: "", hora: "" };
    const idx = paradas.findIndex(p => p.tipo === "destino");
    const a = [...paradas]; a.splice(idx < 0 ? a.length : idx, 0, n); onChange(a);
  };
  const esTP = tipo === "transporte_personal" || tipo === "fijo_multiparada";

  /**
   * Al soltar un marcador: nuevas coordenadas y, sola, la dirección de Google como nombre.
   * Se aplica solo si al volver el paradero sigue en ESE punto y nadie le cambió el nombre
   * mientras tanto; el nombre de antes queda a un clic («↩ Volver a…»).
   */
  const buscarDireccion = async (id: string, lat: string, lng: string, nombreAlSoltar: string) => {
    setRenombres(prev => ({ ...prev, [id]: { ...prev[id], cargando: true, error: undefined } }));
    const sigueIgual = () => {
      const x = vivo.current.paradas.find(q => q.id === id);
      return !!x && x.lat === lat && x.lng === lng && x.nombre === nombreAlSoltar;
    };
    try {
      const dir = await direccionDePunto(Number(lat), Number(lng));
      if (!sigueIgual()) {
        // Lo movieron otra vez: esa búsqueda manda. Si solo le escribieron el nombre, se calla.
        const x = vivo.current.paradas.find(q => q.id === id);
        if (x && x.lat === lat && x.lng === lng) olvidarRenombre(id);
        return;
      }
      if (!dir) { setRenombres(prev => ({ ...prev, [id]: { ...prev[id], cargando: false, error: "Google no devolvió una dirección para ese punto: el nombre quedó como estaba." } })); return; }
      if (dir !== nombreAlSoltar) vivo.current.onChange(vivo.current.paradas.map(x => x.id === id ? { ...x, nombre: dir } : x));
      // El «anterior» es el último nombre que NO puso el mapa: arrastrar dos veces no lo pierde.
      setRenombres(prev => ({ ...prev, [id]: { anterior: prev[id]?.puesto === nombreAlSoltar ? prev[id]?.anterior : nombreAlSoltar, puesto: dir } }));
    } catch (e) {
      if (!sigueIgual()) { const x = vivo.current.paradas.find(q => q.id === id); if (x && x.lat === lat && x.lng === lng) olvidarRenombre(id); return; }
      setRenombres(prev => ({ ...prev, [id]: { ...prev[id], cargando: false, error: `No se pudo buscar la dirección (${e instanceof Error ? e.message : "sin respuesta"}): el nombre quedó como estaba.` } }));
    }
  };
  const moverEnMapa = (id: string, lat: number, lng: number) => {
    const la = Number(lat.toFixed(6)), ln = Number(lng.toFixed(6));
    const actual = vivo.current.paradas;
    const p = actual.find(x => x.id === id);
    if (!p) return;
    vivo.current.onChange(actual.map(x => x.id === id ? { ...x, lat: String(la), lng: String(ln) } : x));
    if (onMoverExtremo && (p.tipo === "inicio" || p.tipo === "destino")) onMoverExtremo(p.tipo, la, ln);
    buscarDireccion(id, String(la), String(ln), p.nombre);
  };
  const reintentarDireccion = (id: string) => {
    const p = vivo.current.paradas.find(x => x.id === id);
    if (p && coordsOk(p)) buscarDireccion(id, p.lat, p.lng, p.nombre);
  };
  const volverNombre = (id: string) => {
    const ant = renombres[id]?.anterior;
    if (ant === undefined) return;
    vivo.current.onChange(vivo.current.paradas.map(x => x.id === id ? { ...x, nombre: ant } : x));
    olvidarRenombre(id);
  };
  /** «＋ Paradero aquí»: dónde va lo decide indiceDeInsercion sobre la ruta; el nombre se propone UNA vez. */
  const insertarEnMapa = (punto: [number, number]) => {
    const lista = ordenarParadas(vivo.current.paradas);
    const conC = lista.filter(coordsOk);
    if (conC.length < 2) return;
    const poli = ruta.vigente && ruta.ruta ? ruta.ruta.poli : [];
    const k = indiceDeInsercion(poli, conC.map(p => ({ lat: Number(p.lat), lng: Number(p.lng) })), punto);
    const antesDe = conC[k];
    const idx = antesDe ? lista.indexOf(antesDe) : lista.length - 1;
    const nuevo: ParadaTP = { id: nId(), tipo: "intermedia", nombre: "", direccion: "", lat: String(Number(punto[1].toFixed(6))), lng: String(Number(punto[0].toFixed(6))), hora: "" };
    const a = [...lista]; a.splice(Math.max(1, idx), 0, nuevo);
    vivo.current.onChange(a);
    direccionDePunto(Number(nuevo.lat), Number(nuevo.lng)).then(dir => {
      if (!dir) return;
      const ahora = vivo.current.paradas;
      // Solo si nadie le escribió un nombre mientras tanto.
      if (ahora.some(x => x.id === nuevo.id && !x.nombre.trim())) vivo.current.onChange(ahora.map(x => x.id === nuevo.id ? { ...x, nombre: dir } : x));
    }).catch(() => { /* el paradero queda con coordenadas y sin nombre: el campo vacío lo pide */ });
  };
  const aplicarHoras = (filas: FilaPlan[], firma: string, porId: Record<string, string>) => {
    const porFila = new Map(filas.map(f => [f.id, f]));
    const actual = vivo.current.paradas;
    vivo.current.onChange(actual.map(p => {
      const f = porFila.get(p.id);
      return f && f.hora_calc ? { ...p, hora: f.hora, hora_calc: f.hora_calc } : p;
    }));
    setAvisos({ firma, porId });
  };
  const ponerSalida = (h: string) => {
    const actual = vivo.current.paradas;
    vivo.current.onChange(actual.map(p => p.tipo === "inicio" ? { ...p, hora: h } : p));
  };

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

  const puntosMapa = ord.filter(coordsOk).map(p => ({ id: p.id, nombre: p.nombre, lat: Number(p.lat), lng: Number(p.lng), numero: ord.indexOf(p) + 1, tipo: p.tipo }));
  const extra = (p: ParadaTP) => ({
    marca: estadoMarca(p, firmaActual),
    aviso: avisos.firma === firmaActual ? avisos.porId[p.id] : undefined,
    renombre: renombres[p.id],
    onVolverNombre: () => volverNombre(p.id),
    onReintentarDireccion: () => reintentarDireccion(p.id),
  });

  return (
    <div className="space-y-3">
      {puntosMapa.length >= 2 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-black text-gray-600">🗺 Mapa de la ruta</span>
            {verMapa && <span className="text-[10px] text-gray-400">Arrastra un número para mover ese paradero · clic en la línea para agregar uno</span>}
            {ruta.cargando && <span className="text-[10px] text-gray-400">· trazando la ruta…</span>}
            <button type="button" onClick={() => setVerMapa(v => !v)} className="ml-auto text-[10px] font-bold text-[#0b315f] hover:underline">{verMapa ? "Ocultar mapa" : "Ver mapa"}</button>
          </div>
          {ruta.error && <p className="text-[10px] text-red-600">⚠ No se pudo trazar la ruta: {ruta.error}</p>}
          {!ruta.completo && <p className="text-[10px] text-gray-500">El mapa y la ruta solo incluyen los paraderos con coordenadas ({puntosMapa.length} de {ord.length}).</p>}
          {verMapa && (
            <MapaParaderos puntos={puntosMapa} poli={ruta.ruta?.poli ?? null} onMover={moverEnMapa} onInsertar={insertarEnMapa}
              colorRuta={contexto?.sentido === "retorno" ? "#5b21b6" : "#0b315f"} />
          )}
        </div>
      )}
      {contexto && ord.length >= 2 && (
        <BarraHorasParaderos paradas={ord} contexto={contexto} ruta={ruta} onAplicar={aplicarHoras} onPonerSalida={ponerSalida} />
      )}
      {inicio && <CardParada p={inicio} lbl={esTP ? "🟢 Paradero 1" : "🟢 Inicio"} col="#16a34a" onUpd={upd} onSel={sel} mapsLoaded={mapsLoaded} {...extra(inicio)} />}
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
          {...extra(p)}
        />
      ))}
      <button type="button" onClick={addMed} className="w-full py-2.5 rounded-xl border-2 border-dashed font-bold text-sm hover:bg-blue-50 transition-colors" style={{ borderColor: "#0b315f", color: "#0b315f" }}>
        + {esTP ? "Paradero intermedio" : "Parada intermedia"}
      </button>
      {fin && <CardParada p={fin} lbl={esTP ? "🔴 Último Paradero" : "🔴 Destino"} col="#dc2626" onUpd={upd} onSel={sel} mapsLoaded={mapsLoaded} {...extra(fin)} />}
    </div>
  );
}

// Ficha Técnica de Ruta: el documento se arma en lib/ficha-ruta-html.ts (así se puede
// generar y revisar sin navegador). Aquí solo se abre la ventana y se imprime.
function generarFichaRuta(datos:FichaRutaDatos){
  // Sin aviso, un popup bloqueado se veía como que el botón no hacía nada.
  const win=window.open("","_blank");
  if(!win)throw new Error("El navegador bloqueó la ventana emergente. Permite las ventanas emergentes para este sitio y vuelve a intentarlo.");
  win.document.write(buildFichaRutaHtml(datos).replace("</body>","<script>window.onload=()=>setTimeout(()=>window.print(),400);<\/script></body>"));
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
// Un extremo de tramo: un lugar elegido de la lista (o por coordenadas), o el TEXTO de una
// dirección que nadie eligió de la lista — Google también lo acepta y lo geocodifica él.
type PuntoKmCot={placeId:string;lat:number;lng:number}|{texto:string};
const claveKmCot=(p:PuntoKmCot)=>"texto" in p?`t:${p.texto.trim().toLowerCase()}`:clavePuntoCot(p);
const refKmCot=(p:PuntoKmCot)=>"texto" in p?p.texto:p.placeId?{placeId:p.placeId}:{location:{lat:p.lat,lng:p.lng}};
/** Km por carretera de un tramo (redondeado), con caché. `null` = Google no pudo calcularlo. */
function kmTramoCot(a:PuntoKmCot,b:PuntoKmCot):Promise<number|null>{
  const clave=`${claveKmCot(a)}>${claveKmCot(b)}`;
  const hit=cacheTramosCot.get(clave);
  // `undefined` = el par no está en caché; un 0 cacheado sí es un km real.
  if(hit!==undefined)return Promise.resolve(hit);
  return new Promise(resolve=>{
    try{
      const g=(window as any).google.maps;
      new g.DistanceMatrixService().getDistanceMatrix({origins:[refKmCot(a)],destinations:[refKmCot(b)],travelMode:g.TravelMode.DRIVING,unitSystem:g.UnitSystem.METRIC},(resp:any)=>{
        const el=resp?.rows?.[0]?.elements?.[0];
        if(el?.status==="OK"){const km=Math.round(el.distance.value/1000);cacheTramosCot.set(clave,km);resolve(km);}
        else resolve(null);
      });
    }catch{resolve(null);}
  });
}

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

/**
 * Las coordenadas de un punto de la «Ruta del servicio», con de dónde salieron. Antes no se
 * enseñaban nunca: no había forma de saber si un punto tenía coordenadas (y sin ellas no hay km
 * ni mapa) o solo un texto. La frase de la fuente la compone el módulo puro, no esta pantalla.
 */
function CoordsDePunto({place,texto,buscando,fallo,vacioDice}:{place:PuntoRuta|null;texto:string;buscando:boolean;fallo:boolean;vacioDice?:string}){
  if(place&&coordValida(place.lat,place.lng)){
    const r=rotuloFuente(place.fuente);
    return(
      <p className={`text-[10px] leading-tight ${r.aproximada?"text-amber-600":"text-gray-500"}`}>
        📍 <span className="font-mono">{place.lat.toFixed(6)}, {place.lng.toFixed(6)}</span>{r.texto&&<> · {r.texto}</>}
        {" · "}<a href={`https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">Ver en Maps</a>
      </p>
    );
  }
  if(buscando)return <p className="text-[10px] text-gray-400">⏳ Buscando las coordenadas de este texto…</p>;
  if(!texto.trim())return vacioDice?<p className="text-[10px] text-gray-400">{vacioDice}</p>:null;
  return <p className="text-[10px] text-amber-600 leading-tight">⚠ Sin coordenadas{fallo?" (Google no encontró este texto)":""}: elige el punto de la lista o usa «Usar coordenadas». Sin ellas no se calcula el km.</p>;
}

/**
 * El mapa de la ruta ORIGEN → DESTINO (→ RETORNO) cuando no hay paraderos que lo dibujen. Usa la
 * misma consulta de ruta y el mismo mapa que los paraderos: arrastrar un punto lo corrige (y su
 * texto pasa a ser la dirección de Google, igual que en los paraderos), y no ofrece insertar — aquí no hay lista.
 * Sin punto de retorno, la vuelta se dibuja al origen: es lo que mide el km.
 */
function MapaRutaServicio({origen,destino,retorno,vuelve,nombres,onMover}:{
  origen:PuntoRuta;destino:PuntoRuta;retorno:PuntoRuta|null;vuelve:boolean;
  nombres:{origen:string;destino:string;retorno:string};
  onMover:(e:Extremo,lat:number,lng:number)=>void;
}){
  const conRetorno=vuelve&&!!retorno&&coordValida(retorno.lat,retorno.lng);
  const fin=vuelve?(conRetorno?retorno!:origen):null;
  const finLat=fin?.lat??null,finLng=fin?.lng??null;
  const ptsRuta=useMemo(()=>{
    const l=[{id:"origen",nombre:nombres.origen||"Origen",lat:String(origen.lat),lng:String(origen.lng)},{id:"destino",nombre:nombres.destino||"Destino",lat:String(destino.lat),lng:String(destino.lng)}];
    if(finLat!==null&&finLng!==null)l.push({id:conRetorno?"retorno":"vuelta",nombre:conRetorno?(nombres.retorno||"Retorno"):(nombres.origen||"Origen"),lat:String(finLat),lng:String(finLng)});
    return l;
  },[origen.lat,origen.lng,destino.lat,destino.lng,finLat,finLng,conRetorno,nombres.origen,nombres.destino,nombres.retorno]);
  const ruta=useRutaParaderos(ptsRuta);
  const puntos=[
    {id:"origen",nombre:nombres.origen,lat:origen.lat,lng:origen.lng,numero:1,tipo:"inicio" as const},
    {id:"destino",nombre:nombres.destino,lat:destino.lat,lng:destino.lng,numero:2,tipo:(conRetorno?"intermedia":"destino") as "intermedia"|"destino"},
    ...(conRetorno?[{id:"retorno",nombre:nombres.retorno,lat:retorno!.lat,lng:retorno!.lng,numero:3,tipo:"destino" as const}]:[]),
  ];
  return(
    <div className="md:col-span-3 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">🗺 Ruta en el mapa</p>
        {ruta.cargando&&<span className="text-[10px] text-gray-400">trazando…</span>}
        {ruta.error&&<span className="text-[10px] text-red-500">⚠ {ruta.error}</span>}
      </div>
      <p className="text-[10px] text-gray-400">1 origen · 2 destino{conRetorno?" · 3 retorno":vuelve?" · la vuelta llega al origen":""}. Arrastra un punto para corregirlo: su dirección se actualiza sola (puedes volver al texto de antes) y el km se vuelve a medir.</p>
      <MapaParaderos puntos={puntos} poli={ruta.ruta?.poli??null} onMover={(id,lat,lng)=>onMover(id as Extremo,lat,lng)}/>
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
  // Pegar el par entero ("-12.276661696156975, -76.86959687911232", tal como lo copia
  // Google Maps) en cualquiera de los dos campos reparte lat y lng. Antes eso dejaba una
  // latitud buena junto a una longitud vieja, o directamente "coordenadas inválidas".
  const pegarPar=(texto:string):boolean=>{
    if(!/[,;/\s]/.test(texto.trim()))return false;   // un solo número: no hay par que repartir
    const par=parsearParCoordenadas(texto);
    if(!par)return false;
    setLatInput(String(par.lat));setLngInput(String(par.lng));setCoordError("");
    return true;
  };
  const geocodificar=async()=>{
    const lat=parsearCoordenada(latInput);
    const lng=parsearCoordenada(lngInput);
    if(lat===null||lng===null){setCoordError("Coordenadas inválidas");return;}
    if(Math.abs(lat)>90||Math.abs(lng)>180){setCoordError("Coordenadas fuera de rango (lat ±90, lng ±180)");return;}
    if(!mapsLoaded||(window as any).google?.maps?.Geocoder===undefined){setCoordError("Google Maps no está listo");return;}
    setBuscando(true);setCoordError("");
    try{
      const geocoder=new (window as any).google.maps.Geocoder();
      const response=await geocoder.geocode({location:{lat,lng},language:"es",region:"PE"});
      const results=response?.results??response;
      if(results&&results[0]){
        const address=results[0].formatted_address;
        // A propósito SIN place_id: el de la geocodificación inversa es el de la dirección
        // más cercana (una manzana, un tramo de avenida), y su centroide puede quedar a
        // decenas de metros. Como el place_id manda sobre las coordenadas al pedirle el
        // kilometraje a Google, devolverlo aquí tiraría a la basura el punto exacto que se
        // acaba de tipear. El operador dio coordenadas: mandan las coordenadas.
        onChange(address);onSelect({address,lat,lng,placeId:""});
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
                onChange={e=>{if(pegarPar(e.target.value))return;setLatInput(e.target.value);setCoordError("");}}
                onKeyDown={e=>e.key==="Enter"&&lngInput&&geocodificar()}
                className="w-full border border-blue-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono bg-white" autoFocus/>
            </div>
            <div>
              <label className="block text-[9px] font-bold uppercase text-gray-500 mb-1">Longitud</label>
              <input type="text" inputMode="decimal" placeholder="-77.04280" value={lngInput}
                onChange={e=>{if(pegarPar(e.target.value))return;setLngInput(e.target.value);setCoordError("");}}
                onKeyDown={e=>e.key==="Enter"&&latInput&&geocodificar()}
                className="w-full border border-blue-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono bg-white"/>
            </div>
          </div>
          <p className="text-[9px] text-blue-500/80 leading-tight">Pega el par completo de Google Maps en cualquiera de los dos campos y se reparte solo. Se guarda con todos sus decimales.</p>
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
// La cartera ENTERA, por páginas con orden total: PostgREST corta en 1000 filas y el buscador no
// puede decir «no hay» de un cliente que quedó en la página 2. null = no se pudo leer (no es «vacía»).
async function leerClientes():Promise<Cliente[]|null>{
  const out:Cliente[]=[];
  for(let d=0;d<50000;d+=1000){const{data,error}=await supabase.from("clientes").select("*").order("nombre").order("id").range(d,d+999);if(error)return null;out.push(...(data||[]));if(!data||data.length<1000)break;}
  return out;
}
type ContactoCl={nombre:string|null;apellido:string|null;cargo:string|null;telefono:string|null;email:string|null;principal:boolean|null};

export default function CotizacionesPage(){
  const [clientes,setClientes]=useState<Cliente[]>([]);const [cotizas,setCotizas]=useState<CotFila[]>([]);const [tarifas,setTarifas]=useState<Tarifa[]>([]);const [flota,setFlota]=useState<VehiculoFlota[]>([]);const [flotaTercero,setFlotaTercero]=useState<VehiculoTerceroFlota[]>([]);const [paramsDB,setParamsDB]=useState<ParamCosto[]>([]);const [preciosDB,setPreciosDB]=useState<Record<string,number>>({});
  const [cargandoClientes,setCargandoClientes]=useState(true);const [errorClientes,setErrorClientes]=useState(false);const [contactosDe,setContactosDe]=useState<{id:string;lista:ContactoCl[]}>({id:"",lista:[]});
  // «+ Crear» abre /clientes en otra pestaña: solo si ESTA pantalla lo pidió se autoselecciona el creado.
  const esperaClienteRef=useRef(false);
  const [loading,setLoading]=useState(false);const [guardando,setGuardando]=useState(false);const [mostrarForm,setMostrarForm]=useState(false);const [editandoId,setEditandoId]=useState<number|null>(null);const [busqueda,setBusqueda]=useState("");const [filtroEst,setFiltroEst]=useState("todos");const [filtroModo,setFiltroModo]=useState("todos");
  const [draftRecuperado,setDraftRecuperado]=useState(false);
  // ── Lista liviana por PERIODO (lib/cotizaciones-filtros.ts + lib/cotizaciones-datos.ts) ──
  // `busqueda` es lo que se teclea; `busquedaDeb` lo que filtra (200 ms después).
  const [busquedaDeb,setBusquedaDeb]=useState("");
  const [periodo,setPeriodo]=useState<Periodo>(PERIODO_DEFECTO);const [eje,setEje]=useState<EjeFecha>(EJE_DEFECTO);
  const [rangoManual,setRangoManual]=useState<{desde:string;hasta:string}>({desde:"",hasta:""});
  // Los filtros guardados se leen en un efecto (sessionStorage no existe al pre-renderizar):
  // hasta entonces no se consulta, para no pedir dos veces la lista.
  const [filtrosListos,setFiltrosListos]=useState(false);
  // `listaDe` = la clave (eje + periodo) cuyas filas están en `cotizas`. Si no es la vigente,
  // lo que hay en memoria es de OTRO periodo y no se enseña: se dice «Cargando…».
  const [listaDe,setListaDe]=useState<string|null>(null);
  const [cargandoLista,setCargandoLista]=useState(false);
  const [errorLista,setErrorLista]=useState<{clave:string;motivo:string}|null>(null);
  const [sinColumnasLista,setSinColumnasLista]=useState<string[]>([]);
  const [historialSel,setHistorialSel]=useState<FilaHistorialSelector[]>([]);
  const [paginado,setPaginado]=useState<{clave:string;n:number}>({clave:"",n:PASO_LISTA});
  const [detalleCargando,setDetalleCargando]=useState<{id:number;accion:string}|null>(null);
  // Frena el segundo clic aunque React todavía no haya pintado los botones deshabilitados.
  const accionEnCursoRef=useRef(false);
  // Cambiar el estado / marcar enviada / aprobar: una escritura a la vez (id de la cotización).
  const [estadoEnCurso,setEstadoEnCurso]=useState<number|null>(null);const estadoEnCursoRef=useRef(false);
  const reqListaRef=useRef(0);
  const cacheDetalle=useRef(new Map<number,Cotizacion>());
  // ── PLANTILLAS DEL PDF (lib/cotizacion-plantillas.ts) ──────────────────────────────────
  // La lista y las reglas de uso (servicio × tipo de cliente). `reglasPl: null` = falta el SQL de
  // las reglas (o no se pudo leer: `lecturaPl.error`): entonces se usa la corporativa, como antes.
  const [plantillas,setPlantillas]=useState<PlantillaFila[]>([]);const [reglasPl,setReglasPl]=useState<ReglaPlantilla[]|null>(null);
  const [lecturaPl,setLecturaPl]=useState<{cargada:boolean;error:string|null;sinDiseno:boolean}>({cargada:false,error:null,sinDiseno:false});
  // La plantilla del formulario: en una cotización NUEVA la decide la regla (`usoAuto`) salvo que se
  // elija a mano; al EDITAR es la guardada (`plantilla_pdf`, o la corporativa).
  const [plantillaFijada,setPlantillaFijada]=useState<{id:string;origen:"manual"|"guardada"}|null>(null);
  // Las condiciones que alguien TOCÓ (o que trae la cotización abierta). null = sin tocar: el
  // formulario enseña las de su plantilla y cambian con ella (`considAuto`). Es lo que antes hacía
  // `considSinTocarRef`.
  const [considEditada,setConsidEditada]=useState<ConsidFila|null>(null);
  // Mientras se lee la plantilla de una cotización abierta no se guarda: sus condiciones dependen de ella.
  const [considPendiente,setConsidPendiente]=useState(false);const [avisoConsidForm,setAvisoConsidForm]=useState("");
  const reqConsidRef=useRef(0);
  // El idioma lo eligió una persona: una plantilla en inglés ya no lo cambia. `idiomaAplicadoRef` =
  // la plantilla cuyo idioma ya se aplicó (para no volver a aplicarlo en cada render).
  const idiomaTocadoRef=useRef(false);const idiomaAplicadoRef=useRef<string|null>(null);
  const [form,setForm]=useState(FORM0);const [items,setItems]=useState<ItemCot[]>([{...ITEM_VACIO}]);const [modalAprob,setModalAprob]=useState<CotFila|null>(null);const [guardarTar,setGuardarTar]=useState(true);const [paradas,setParadas]=useState<ParadaTP[]>([]);const [paradasRetorno,setParadasRetorno]=useState<ParadaTP[]>([]);const [panelId,setPanelId]=useState<number|null>(null);
  const [diasCond,setDiasCond]=useState(1);const [peajesF,setPeajesF]=useState(0);const [pernocteF,setPernocteF]=useState(0);const [viaticosF,setViaticosF]=useState(0);const [reprNombre,setReprNombre]=useState("");
  // ── La plantilla y las condiciones del formulario ──
  // La regla (servicio × tipo de cliente) para una cotización NUEVA. Sin las reglas (falta el SQL) o
  // si la lista no se pudo leer, la corporativa, como antes. Mientras se lee no se afirma nada.
  const tipoClienteForm=clientes.find(c=>String(c.id)===form.cliente_id)?.tipo??null;
  const usoAuto=useMemo<{id:string;codigo:CodigoUso|"cargando"|"lectura_fallida";detalle:string;celda:string}>(()=>{
    const u={servicio:servicioDeCotizacion({modo_servicio:form.modo_servicio,tipo_servicio:form.tipo_servicio}),segmento:segmentoDeCliente({moneda:form.moneda,tipoCliente:tipoClienteForm})};
    const celda=etiquetaCelda(u);
    if(!lecturaPl.cargada)return{id:"corporativo",codigo:"cargando",detalle:"",celda};
    if(lecturaPl.error)return{id:"corporativo",codigo:"lectura_fallida",detalle:lecturaPl.error,celda};
    if(reglasPl===null){
      const corp=plantillaPorId(plantillas,"corporativo");
      if(corp&&esActiva(corp))return{id:"corporativo",codigo:"sin_reglas",detalle:`Falta ${SQL_PLANTILLAS_USO}: todavía no hay reglas de uso y se usa la corporativa, como antes.`,celda};
    }
    const r=plantillaParaUso(u,plantillas,reglasPl);
    return{id:r.plantilla?.id??"corporativo",codigo:r.codigo,detalle:r.detalle,celda};
  },[lecturaPl,reglasPl,plantillas,form.modo_servicio,form.tipo_servicio,form.moneda,tipoClienteForm]);
  const plantillaForm=plantillaFijada?.id??usoAuto.id;
  const filaForm=plantillaPorId(plantillas,plantillaForm);
  const nombrePlantilla=(id:string|null|undefined)=>{if(!id)return null;const p=plantillaPorId(plantillas,id);return p?(p.nombre||p.id):null;};
  /**
   * Las condiciones que COPIA una plantilla al formulario (`considSnapshot`, versión 2): una lista
   * que la plantilla no tiene (NULL) sale de la principal, y si tampoco, de las de fábrica.
   */
  const considDePlantilla=(p:PlantillaFila|null):ConsidFila=>considSnapshot(p,considSnapshot(plantillaPrincipal(plantillas),DEFAULT_CONSID));
  const considAuto=considDePlantilla(filaForm);
  const consid:ConsidFila=considEditada??considAuto;
  /** Editar una condición la vuelve «tocada»: desde ahí ni la regla ni otra plantilla la pisan. */
  const setConsid=(v:ConsidFila|((prev:ConsidFila)=>ConsidFila))=>setConsidEditada(prev=>typeof v==="function"?v(prev??considAuto):v);
  const [modalPlantilla,setModalPlantilla]=useState<Cotizacion|null>(null);const [plantillaElegida,setPlantillaElegida]=useState("corporativo");
  const [modalEnvio,setModalEnvio]=useState<CotFila|null>(null);
  const [rolUsuario,setRolUsuario]=useState<string>("operador");
  const [modalEliminar,setModalEliminar]=useState<CotFila|null>(null);
  const [fichaCargando,setFichaCargando]=useState<number|null>(null);
  const [modalPropagar,setModalPropagar]=useState<{cotId:number;reservas:{id:number;direccion_servicio:string|null}[];paradasIda:ParadaTP[];paradasRet:ParadaTP[]}|null>(null);
  const [propagando,setPropagando]=useState(false);
  const [vehExpandido,setVehExpandido]=useState(false);
  const [pendDespacho,setPendDespacho]=useState<number|null>(null);const [errDespacho,setErrDespacho]=useState<string|null>(null);const [modalDespacho,setModalDespacho]=useState(false);const despachoOrigenRef=useRef<ReservaDespacho|null>(null);const [despachoOrigen,setDespachoOrigen]=useState<ReservaDespacho|null>(null);
  const [fechasMultidia,setFechasMultidia]=useState<FechaMultidia[]>([]);
  const skipFechasRef=useRef(false);
  const skipDescRef=useRef(false);
  const skipParadasRef=useRef(false);
  // ── MONEDA DE LA COTIZACIÓN (lib/cotizacion-moneda.ts) ──────────────────────────────────
  // Lo que se GUARDA siempre está en soles. Lo que se TECLEA (ítems y precio/día) está en la
  // moneda en que hoy se enseña el formulario: `monedaItems`. Solo pasa a US$ cuando hay un tipo
  // de cambio válido — sin él los importes siguen en soles y lo dicen, nunca soles rotulados US$.
  const [monedaItems,setMonedaItems]=useState<Moneda>("PEN");
  const [ultimoTc,setUltimoTc]=useState<number|null>(null);
  // Al pasar a dólares se recuerdan los soles exactos: volver a soles sin haber tocado nada los
  // devuelve tal cual (la ida y vuelta por 2 decimales no los mueve ni un céntimo).
  const baseSolesRef=useRef<{tc:number;usd:string;items:ItemCot[];precioDia:string}|null>(null);
  const [sugTc,setSugTc]=useState<SugerenciaTc|null>(null);
  // Sin la migración (cotizaciones-04) no se puede cotizar en dólares: lo dice la lista (columna
  // soltada) o el guardado (la base rechazó la columna).
  const [faltaMonedaGuardado,setFaltaMonedaGuardado]=useState(false);
  // ── PDF: idioma elegido en el modal y los avisos de htmlCotizacion para esa combinación ──
  const [idiomaPdfModal,setIdiomaPdfModal]=useState<Idioma>("es");
  const [avisosPdf,setAvisosPdf]=useState<AvisoPdf[]|null>(null);const [errorAvisosPdf,setErrorAvisosPdf]=useState("");
  const [generandoPdf,setGenerandoPdf]=useState(false);
  // Mismo predicado para el chip y la lista del modal (pendientesDeCotizar). Si la lectura falla
  // el chip dice «?» con el error: nunca un 0 falso.
  const contarDespacho=async()=>{try{const{filas}=await leerDespachosSinCotizar(supabase);setPendDespacho(pendientesDeCotizar(filas).length);setErrDespacho(null);}catch(e:any){setPendDespacho(null);setErrDespacho(e?.message??String(e));}};
  useEffect(()=>{contarDespacho();if(typeof window!=="undefined"&&new URLSearchParams(window.location.search).get("regularizar")==="1")setModalDespacho(true);// eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // Deep-link desde el CRM: /cotizaciones?nuevo=1&cliente=<id>&asunto=<texto> abre el
  // formulario nuevo con el cliente ya elegido.
  useEffect(()=>{
    if(typeof window==="undefined")return;
    const q=new URLSearchParams(window.location.search);
    if(q.get("nuevo")!=="1")return;
    limpiar();
    setForm({...FORM0,cliente_id:q.get("cliente")??"",asunto:q.get("asunto")??FORM0.asunto});
    setMostrarForm(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const fijarDespachoOrigen=(r:ReservaDespacho|null)=>{despachoOrigenRef.current=r;setDespachoOrigen(r);};
  const cotizarDespacho=(r:ReservaDespacho)=>{
    const p=prellenadoCotizacion(r,hoyLima());
    const cl=p.cliente_id!=null?clientes.find(c=>c.id===p.cliente_id):null;
    setModalDespacho(false);limpiar();
    skipDescRef.current=true;
    setForm({...FORM0,cliente_id:p.cliente_id!=null?String(p.cliente_id):"",incluye_igv:cl?(cl as any).tipo==="b2b":FORM0.incluye_igv,origen:p.origen,destino:p.destino,fecha_servicio:p.fecha_servicio,hora_ida:p.hora_ida,modo_servicio:p.modo_servicio,tipo_servicio:p.tipo_servicio,asunto:p.asunto});
    setItems(p.items.map(it=>({...ITEM_VACIO,descripcion:it.descripcion,cantidad:it.cantidad,precio_unit:it.precio_unit??0})));
    fijarDespachoOrigen(r);setMostrarForm(true);
    setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50);
  };
  // Deep-link desde Programación: /cotizaciones?buscar=<N°> siembra el buscador.
  // Se lee de window.location (cliente) para no requerir <Suspense> de useSearchParams.
  // Un N° que llega por enlace puede ser de hace meses: se busca en TODAS las fechas.
  useEffect(()=>{
    if(typeof window==="undefined")return;
    try{
      const raw=sessionStorage.getItem(CLAVE_FILTROS_COT);
      if(raw){
        const f=JSON.parse(raw)||{};
        if((PERIODOS as readonly string[]).includes(f.periodo))setPeriodo(f.periodo);
        if(f.eje==="emision"||f.eje==="servicio")setEje(f.eje);
        setRangoManual({desde:typeof f.desde==="string"?f.desde:"",hasta:typeof f.hasta==="string"?f.hasta:""});
        if(ESTADOS_FILTRO.includes(f.estado))setFiltroEst(f.estado);
        if(MODOS_FILTRO.includes(f.modo))setFiltroModo(f.modo);
      }
    }catch{/* sin sessionStorage: los filtros por defecto */}
    const b=new URLSearchParams(window.location.search).get("buscar");
    if(b){setBusqueda(b);setBusquedaDeb(b);setPeriodo("todo");}
    setFiltrosListos(true);
  },[]);
  useEffect(()=>{
    if(!filtrosListos)return;
    try{sessionStorage.setItem(CLAVE_FILTROS_COT,JSON.stringify({periodo,eje,desde:rangoManual.desde,hasta:rangoManual.hasta,estado:filtroEst,modo:filtroModo}));}catch{/* best-effort */}
  },[filtrosListos,periodo,eje,rangoManual,filtroEst,filtroModo]);
  useEffect(()=>{const t=setTimeout(()=>setBusquedaDeb(busqueda),200);return()=>clearTimeout(t);},[busqueda]);
  const mapsLoaded=useGoogleMapsCot();
  const [origenPlace,setOrigenPlace]=useState<PuntoRuta|null>(null);
  const [destinoPlace,setDestinoPlace]=useState<PuntoRuta|null>(null);
  /**
   * EL KM GUARDADO NO SE PISA AL REABRIR (lib/cotizacion-ruta-coords.ts). Restaurar los puntos es
   * cambiarlos, y sin este freno abrir una cotización reescribiría su km —que pudo corregirse a
   * mano— con el de unas coordenadas que a veces son aproximadas. Congelado = no se mide mientras el
   * servicio vuelva igual y el retorno tenga el mismo texto; tocar un punto lo descongela.
   */
  const [kmCongelado,setKmCongelado]=useState<{vuelve:boolean;ret:string}|null>(null);
  /** Puntos que al reabrir no tenían coordenadas guardadas: se buscan por el texto (aproximadas). */
  const [porGeocodificar,setPorGeocodificar]=useState<Extremo[]>([]);
  const [geoFallo,setGeoFallo]=useState<Extremo[]>([]);
  // `null` = todavía no hay km calculado por Maps (0 sí es un valor válido: tramos < 500 m).
  const [kmBase,setKmBase]=useState<number|null>(null);
  /**
   * EL KM DEL SERVICIO ES IDA + RETORNO, Y EL RETORNO SE MIDE, NO SE SUPONE.
   *
   * Antes solo «Ida y Retorno» y «Transporte personal» duplicaban el tramo de ida; los demás
   * tipos con retorno (con paraderos, retén, full day, multi-día…) costeaban SOLO la ida aunque
   * el formulario pidiera el punto de retorno, y ese punto no se consultaba nunca. Ahora todo
   * servicio que no es «Solo ida» suma el tramo destino → punto de retorno (el origen si está
   * vacío). `null` = sin calcular o Google no pudo: entonces se estima igual a la ida y se dice.
   */
  const [kmRet,setKmRet]=useState<number|null>(null);
  const [retornoPlace,setRetornoPlace]=useState<PuntoRuta|null>(null);
  const [calculandoKm,setCalculandoKm]=useState(false);
  const [errorKm,setErrorKm]=useState("");
  const [avisoRet,setAvisoRet]=useState("");
  const vuelve=!["solo_ida","fijo_solo_ida"].includes(form.tipo_servicio);
  // El texto tecleado solo cuenta mientras no se eligió un lugar de la lista.
  const textoRet=retornoPlace?"":form.punto_retorno.trim();
  useEffect(()=>{
    // `cancelado` evita que la respuesta de un destino ya cambiado pise el km
    // del destino actual (quedaría un kilometraje equivocado en la cotización).
    let cancelado=false;
    // Sin ruta completa no hay consulta en vuelo: se libera el bloqueo de guardado.
    if(!mapsLoaded||!origenPlace||!destinoPlace){setCalculandoKm(false);return;}
    if(kmCongelado&&kmCongelado.vuelve===vuelve&&kmCongelado.ret===form.punto_retorno.trim()){setCalculandoKm(false);return;}
    const finRet:PuntoKmCot|null=!vuelve?null:retornoPlace??(textoRet?{texto:textoRet}:origenPlace);
    setErrorKm("");setCalculandoKm(true);
    // Con el retorno escrito a mano se espera a que se deje de teclear: una consulta por tecla
    // es una llamada pagada a Google por letra.
    const espera=setTimeout(async()=>{
      const [ida,ret]=await Promise.all([kmTramoCot(origenPlace,destinoPlace),finRet?kmTramoCot(destinoPlace,finRet):Promise.resolve(null)]);
      if(cancelado)return;
      if(ida===null){
        // Sin respuesta útil (OVER_QUERY_LIMIT, REQUEST_DENIED, red caída, ZERO_RESULTS o
        // NOT_FOUND de campamentos y destinos rurales). Se borra el km para no conservar
        // el del destino anterior y se avisa para que se ingrese a mano.
        setKmBase(null);setKmRet(null);setAvisoRet("");setForm(p=>({...p,km:""}));setErrorKm("⚠️ Google Maps no pudo calcular el kilometraje de esta ruta. Ingrésalo a mano.");setCalculandoKm(false);return;
      }
      setKmRet(ret);setKmBase(ida);
      setAvisoRet(finRet&&ret===null?"⚠️ Google Maps no pudo calcular el tramo de retorno: se estimó igual a la ida. Revisa el punto de retorno o corrige el km a mano.":"");
      setCalculandoKm(false);
    },finRet&&"texto" in finRet?700:0);
    return()=>{cancelado=true;clearTimeout(espera);};
  },[mapsLoaded,origenPlace?.placeId,origenPlace?.lat,origenPlace?.lng,destinoPlace?.placeId,destinoPlace?.lat,destinoPlace?.lng,retornoPlace?.placeId,retornoPlace?.lat,retornoPlace?.lng,textoRet,vuelve,kmCongelado,form.punto_retorno]);
  useEffect(()=>{
    if(kmBase===null)return;
    setForm(p=>({...p,km:String(vuelve?kmBase+(kmRet??kmBase):kmBase)}));
  },[kmBase,kmRet,vuelve]);

  /** Al reabrir (cotización o borrador): las coordenadas por la cascada de lib/cotizacion-ruta-coords.ts. */
  const restaurarRuta=(c:{origen:string|null;destino:string|null;punto_retorno:string|null;tipo_servicio:string|null;km?:number|string|null;ruta_coords_json?:unknown;paradas_json?:ParadaTP[]|null})=>{
    const vuelveC=!["solo_ida","fijo_solo_ida"].includes(c.tipo_servicio||"solo_ida");
    const r=resolverRestauracion(c,vuelveC);
    setOrigenPlace(r.origen);setDestinoPlace(r.destino);setRetornoPlace(r.retorno);
    setPorGeocodificar(r.porGeocodificar);setGeoFallo([]);setRenombreRuta({});
    setKmCongelado(Number(c.km)>0?{vuelve:vuelveC,ret:String(c.punto_retorno||"").trim()}:null);
  };
  // Lo que el operador tiene escrito AHORA: una búsqueda por texto que vuelve tarde no pisa un
  // punto que ya cambió.
  const textosRuta=useRef({origen:"",destino:"",retorno:""});
  useEffect(()=>{textosRuta.current={origen:form.origen,destino:form.destino,retorno:form.punto_retorno};},[form.origen,form.destino,form.punto_retorno]);
  useEffect(()=>{
    // Una cotización vieja (sin coordenadas guardadas ni paraderos) solo tiene el texto: se busca
    // en Google y se marca APROXIMADA. Una consulta por punto, solo al reabrir.
    if(!mapsLoaded||porGeocodificar.length===0)return;
    type Geo={geocode:(r:{address:string;region:string;language:string})=>Promise<{results?:{geometry?:{location?:{lat:()=>number;lng:()=>number}}}[]}>};
    const G=(window as unknown as {google?:{maps?:{Geocoder?:new()=>Geo}}}).google?.maps?.Geocoder;
    if(!G)return;
    let vivo=true;
    const pedidos={...textosRuta.current};
    const geocoder=new G();
    (async()=>{
      const fallos:Extremo[]=[];
      for(const e of porGeocodificar){
        const texto=pedidos[e].trim();
        if(!texto)continue;
        try{
          const resp=await geocoder.geocode({address:texto,region:"PE",language:"es"});
          const loc=resp?.results?.[0]?.geometry?.location;
          if(!vivo)return;
          if(!loc){fallos.push(e);continue;}
          if(textosRuta.current[e]!==pedidos[e])continue;
          const pt:PuntoRuta={placeId:"",lat:loc.lat(),lng:loc.lng(),fuente:"texto"};
          const poner=(prev:PuntoRuta|null)=>prev??pt;
          if(e==="origen")setOrigenPlace(poner);else if(e==="destino")setDestinoPlace(poner);else setRetornoPlace(poner);
        }catch{fallos.push(e);}
      }
      if(vivo){setPorGeocodificar([]);setGeoFallo(fallos);}
    })();
    return()=>{vivo=false;};
  },[mapsLoaded,porGeocodificar]);
  /**
   * Arrastrar un punto de la ruta (en su mapa, o el paradero 1 / último de la ida): mandan las
   * coordenadas nuevas y el texto del punto pasa a ser la dirección de Google, sola. Se aplica solo
   * si al volver el punto sigue ahí y nadie tocó el texto; el texto de antes queda a un clic.
   */
  const [renombreRuta,setRenombreRuta]=useState<Partial<Record<Extremo,RenombreMapa>>>({});
  const placesRuta=useRef<Record<Extremo,PuntoRuta|null>>({origen:null,destino:null,retorno:null});
  useEffect(()=>{placesRuta.current={origen:origenPlace,destino:destinoPlace,retorno:retornoPlace};},[origenPlace,destinoPlace,retornoPlace]);
  const campoDe=(e:Extremo)=>e==="retorno"?"punto_retorno" as const:e;
  const olvidarRenombreRuta=(e:Extremo)=>setRenombreRuta(prev=>{if(!prev[e])return prev;const n={...prev};delete n[e];return n;});
  const buscarNombreRuta=async(e:Extremo,lat:number,lng:number,textoAlSoltar:string)=>{
    setRenombreRuta(prev=>({...prev,[e]:{...prev[e],cargando:true,error:undefined}}));
    const mismoPunto=()=>{const q=placesRuta.current[e];return!!q&&q.lat===lat&&q.lng===lng;};
    const sigueIgual=()=>mismoPunto()&&textosRuta.current[e]===textoAlSoltar;
    try{
      const dir=await direccionDePunto(lat,lng);
      if(!sigueIgual()){if(mismoPunto())olvidarRenombreRuta(e);return;}
      if(!dir){setRenombreRuta(prev=>({...prev,[e]:{...prev[e],cargando:false,error:"Google no devolvió una dirección para ese punto: el texto quedó como estaba."}}));return;}
      if(dir!==textoAlSoltar){
        const campo=campoDe(e);
        // Se escribe el texto sin pasar por el onChange del campo, que soltaría las coordenadas.
        textosRuta.current={...textosRuta.current,[e]:dir};
        setForm(p=>({...p,[campo]:dir}));
      }
      setRenombreRuta(prev=>({...prev,[e]:{anterior:prev[e]?.puesto===textoAlSoltar?prev[e]?.anterior:textoAlSoltar,puesto:dir}}));
    }catch(err){
      if(!sigueIgual()){if(mismoPunto())olvidarRenombreRuta(e);return;}
      const msg=err instanceof Error?err.message:"sin respuesta";
      setRenombreRuta(prev=>({...prev,[e]:{...prev[e],cargando:false,error:`No se pudo buscar la dirección (${msg}): el texto quedó como estaba.`}}));
    }
  };
  const moverPuntoRuta=(e:Extremo,lat:number,lng:number)=>{
    const pt:PuntoRuta={placeId:"",lat,lng,fuente:"mapa"};
    setKmCongelado(null);
    placesRuta.current={...placesRuta.current,[e]:pt};
    if(e==="origen")setOrigenPlace(pt);else if(e==="destino")setDestinoPlace(pt);else setRetornoPlace(pt);
    buscarNombreRuta(e,lat,lng,textosRuta.current[e]);
  };
  const reintentarNombreRuta=(e:Extremo)=>{const q=placesRuta.current[e];if(q&&coordValida(q.lat,q.lng))buscarNombreRuta(e,q.lat,q.lng,textosRuta.current[e]);};
  const volverNombreRuta=(e:Extremo)=>{
    const ant=renombreRuta[e]?.anterior;
    if(ant===undefined)return;
    const campo=campoDe(e);
    textosRuta.current={...textosRuta.current,[e]:ant};
    setForm(p=>({...p,[campo]:ant}));
    olvidarRenombreRuta(e);
  };
  const [faltaMigracionCoords,setFaltaMigracionCoords]=useState(false);

  const f=(k:keyof typeof FORM0)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}));
  useEffect(()=>{
    /**
     * EL REPRESENTANTE ES EL OPERADOR CON LA SESIÓN ABIERTA, no un nombre fijo.
     *
     * Antes el campo nacía con el nombre de una persona escrito en el código y la cotización
     * salía a su nombre la firmara quien la firmara. Y no es el representante LEGAL de la
     * empresa: es quien atiende ese documento, por eso el PDF lo rotula «REPRESENTANTE».
     *
     * Se busca por los dos caminos porque `user_metadata` suele venir vacío en Supabase: ahí
     * está el nombre solo si alguien lo puso al crear la cuenta. El que siempre existe es
     * `usuarios.nombre`, que es la ficha del operador dentro del ERP — la misma que ya
     * consultaban al guardar. Si no hay ninguno, el campo se queda VACÍO y el PDF omite la
     * línea: un documento sin representante es mejor que uno a nombre de otra persona.
     */
    let usuarioVisto:string|null|undefined;
    const cargarNombre=async(session:any)=>{
      if(!session?.user)return;
      // Una respuesta que llega después de cambiar de usuario no pisa el nombre del vigente.
      const poner=(n:string)=>{if(usuarioVisto===session.user.id)setReprNombre(extraerNombreApellido(n));};
      const m=session.user.user_metadata;
      const fullName=(m?.full_name||m?.name||"").trim();
      if(fullName){poner(fullName);return;}
      try{
        const{data:uRow}=await supabase.from("usuarios").select("nombre").eq("id",session.user.id).maybeSingle();
        const n=String((uRow as any)?.nombre??"").trim();
        if(n){poner(n);return;}
        if(session.user.email){
          const{data:porCorreo}=await supabase.from("usuarios").select("nombre").eq("email",session.user.email).maybeSingle();
          const n2=String((porCorreo as any)?.nombre??"").trim();
          if(n2)poner(n2);
        }
      }catch(e){/* best-effort: sin nombre, el PDF omite la línea */}
    };
    /**
     * EL CALLBACK DE SESIÓN NO ESPERA NADA DE SUPABASE, y es la diferencia entre guardar y colgarse.
     *
     * supabase-js avisa SIGNED_IN cada vez que la pestaña vuelve a estar visible y TOKEN_REFRESHED
     * cada hora, y lo hace CON SU CANDADO DE SESIÓN TOMADO, esperando a que el callback termine.
     * El callback era `async` y hacía `await supabase.from("usuarios")…`: esa consulta pide la
     * sesión, la sesión espera al candado y el candado espera al callback. Desde ese momento TODA
     * consulta de la pestaña quedaba en cola para siempre — «⏳ Guardando…» sin fin y solo F5 lo
     * arreglaba. Pasaba con casi todos los usuarios, porque los creados desde /usuarios no traen
     * `full_name` en `user_metadata` y cargarNombre siempre caía a la consulta.
     *
     * Por eso: callback síncrono, el trabajo se DIFIERE con setTimeout (lo que pide la propia
     * librería) y solo cuando cambia el usuario — volver a la pestaña o renovar el token es la
     * misma persona con el mismo nombre.
     */
    type SesionVista={user?:{id?:string}|null}|null;
    const alCambiarSesion=(session:SesionVista)=>{
      const id:string|null=session?.user?.id??null;
      if(id===usuarioVisto)return;
      usuarioVisto=id;
      // Otra persona en la misma pestaña: su cotización no sale con el nombre de la anterior.
      setTimeout(()=>{setReprNombre("");void cargarNombre(session);},0);
    };
    const{data:{subscription}}=supabase.auth.onAuthStateChange((_event:string,session:SesionVista)=>{alCambiarSesion(session);});
    supabase.auth.getSession().then(({data:{session}}:{data:{session:SesionVista}})=>{alCambiarSesion(session);});
    return()=>subscription.unsubscribe();
  },[]);
  useEffect(()=>{
    supabase.auth.getSession().then(async({data:{session}})=>{
      if(!session?.user)return;
      const{data}=await supabase.from("usuarios").select("rol").eq("id",session.user.id).maybeSingle();
      if(data?.rol)setRolUsuario(data.rol);
    });
  },[]);

  // Periodo vigente de la lista. Se guarda en un ref para que un `cargarLista()` llamado desde una
  // clausura vieja (un modal abierto antes de cambiar el filtro) relea el periodo de AHORA.
  const hoyLista=hoyLimaISO();
  const rangoLista=useMemo(()=>rangoDePeriodo(periodo,hoyLista,rangoManual),[periodo,hoyLista,rangoManual]);
  const claveLista=`${eje}|${rangoLista.codigo}|${rangoLista.desde??""}|${rangoLista.hastaExcl??""}`;
  const paramsListaRef=useRef<{eje:EjeFecha;r:RangoPeriodo;clave:string}>({eje,r:rangoLista,clave:claveLista});
  useEffect(()=>{paramsListaRef.current={eje,r:rangoLista,clave:claveLista};},[eje,rangoLista,claveLista]);
  /** Solo la lista: es lo único que cambia con el periodo, el eje o el rango. */
  const cargarLista=async()=>{
    const id=++reqListaRef.current;
    cacheDetalle.current.clear();
    const{eje:ej,r,clave}=paramsListaRef.current;
    // Un rango sin sus dos fechas, o al revés, no se consulta: la pantalla dice por qué.
    if(r.codigo!=="ok"){setCargandoLista(false);return;}
    setCargandoLista(true);
    try{
      const{filas,sinColumnas}=await leerListaPeriodo(supabase,ej,r);
      if(id!==reqListaRef.current)return; // llegó tarde: ya se pidió otro periodo
      setCotizas(filas as CotFila[]);setSinColumnasLista(sinColumnas);setListaDe(clave);setErrorLista(null);
    }catch(e){
      if(id!==reqListaRef.current)return;
      setErrorLista({clave,motivo:(e as {message?:string})?.message||String(e)});
    }finally{
      if(id===reqListaRef.current)setCargandoLista(false);
    }
  };
  useEffect(()=>{if(filtrosListos)cargarLista();},[filtrosListos,claveLista]);
  /**
   * Las condiciones de una cotización abierta: EXACTAMENTE lo que su PDF imprime hoy
   * (`considParaFormulario` con la plantilla con la que se imprime: `plantilla_pdf`, aunque esté
   * desactivada, o la corporativa), así guardarla —ya en versión 2— no le cambia el PDF. Cuentan
   * como tocadas: ni la regla ni otra plantilla las pisan. Si la plantilla no está en la lista se lee;
   * mientras tanto no se guarda. `delBorrador`: las de un borrador de antes de este cambio, que se
   * conservan si alguien las editó (son las que muestra el formulario). Un TRASLADO de la IA con una
   * plantilla de diseño corporativo imprime SIEMPRE las de su fila (`cfgSoloCuentas`): ahí la
   * plantilla no pone condiciones.
   */
  const fijarConsidDeCotizacion=(c:{plantilla_pdf?:string|null;consideraciones_json?:ConsidFila|null;idioma_pdf?:string|null;traslado_json?:unknown},delBorrador?:ConsidFila|null)=>{
    const idPl=c.plantilla_pdf||"corporativo";
    setPlantillaFijada({id:idPl,origen:"guardada"});setAvisoConsidForm("");
    const idioma=normalizarIdioma(c.idioma_pdf);
    const fila=c.consideraciones_json??null;
    // El borrador de antes ponía `consideraciones_json || las de fábrica` al abrir: si sigue igual, nadie las editó.
    const base=fila??DEFAULT_CONSID;
    const editadasEnBorrador=!!delBorrador&&JSON.stringify([delBorrador.incluye,delBorrador.no_incluye,delBorrador.generales])!==JSON.stringify([base.incluye,base.no_incluye,base.generales]);
    const fijar=(cfg:PlantillaFila|null)=>{
      if(editadasEnBorrador&&delBorrador){setConsidEditada({...delBorrador,plantilla:idPl});return;}
      const imprimeLaFila=esTrasladoIA(c)&&disenoDe(cfg??{id:idPl})==="corporativo";
      const r:ConsidFila=imprimeLaFila&&!fila?{incluye:[],no_incluye:[],generales:[]}:considParaFormulario(imprimeLaFila?null:cfg,fila,idioma);
      setConsidEditada({...r,plantilla:r.plantilla??idPl});
    };
    const req=++reqConsidRef.current;
    const local=plantillaPorId(plantillas,idPl);
    // Con la lista leída sin error, una plantilla que no está es una que ya no existe: imprime sin ella.
    if(local||(lecturaPl.cargada&&!lecturaPl.error)){fijar(local);setConsidPendiente(false);return;}
    fijar(null);setConsidPendiente(true);
    Promise.resolve(supabase.from("cotizacion_plantillas").select("*").eq("id",idPl).maybeSingle())
      .then(({data,error}:{data:PlantillaFila|null;error:{message?:string}|null})=>{
        if(req!==reqConsidRef.current)return;
        if(error)setAvisoConsidForm(`No se pudo leer la plantilla «${idPl}» (${error.message||"error"}): las condiciones que ves son las guardadas en la cotización y el PDF de hoy podría imprimir las de la plantilla. Revísalas antes de guardar.`);
        else fijar(data);
      },(e:unknown)=>{if(req===reqConsidRef.current)setAvisoConsidForm(`No se pudo leer la plantilla «${idPl}» (${String((e as {message?:string})?.message??e)}): las condiciones que ves son las guardadas en la cotización. Revísalas antes de guardar.`);})
      .finally(()=>{if(req===reqConsidRef.current)setConsidPendiente(false);});
  };
  /** Todo lo demás (clientes, tarifas, flota, parámetros, plantilla) y el historial de los selectores. */
  const cargarResto=async()=>{
    setLoading(true);
    // «Recientes» y «Más cotizados» de los selectores: un año, aparte del periodo de la lista.
    // Best-effort: sin él los selectores solo pierden sus sugerencias.
    leerHistorialSelector(supabase,hoyLimaISO()).then(setHistorialSel).catch(()=>{});
    const[clR,tR,vR,pR,cR,vtR,empR,plR]=await Promise.all([leerClientes(),supabase.from("tarifario").select("*").eq("activo",true),supabase.from("vehiculos").select("id,placa,categoria,marca,modelo,anio,capacidad_pasajeros,equipamiento,foto_externa_url,foto_interna_url,descripcion_unidad,tipo_vehiculo_costeo").order("placa"),supabase.from("parametros_costos").select("*").eq("activo",true).order("grupo_vehiculo").order("capacidad"),supabase.from("precios_combustible").select("tipo,precio"),supabase.from("vehiculos_tercero").select("id,empresa_id,placa,categoria,marca,modelo,capacidad,estado,foto_externa_url,foto_interna_url,descripcion_unidad,tipo_vehiculo_costeo").neq("estado","inactivo").order("placa"),supabase.from("empresas_tercerizadas").select("id,razon_social").order("razon_social"),leerPlantillasYReglas(supabase).catch((e:unknown)=>({ok:false as const,plantillas:[] as PlantillaFila[],reglas:null,reglasTraslado:null,sinDiseno:false,error:String((e as {message?:string})?.message??e)}))]);
    if(clR){setClientes(clR);setErrorClientes(false);}else setErrorClientes(true);setCargandoClientes(false);setTarifas(tR.data||[]);setFlota(vR.data||[]);setParamsDB(pR.data||[]);
    const pr:Record<string,number>={};(cR.data||[]).forEach((c:any)=>{pr[c.tipo]=Number(c.precio);});setPreciosDB(pr);
    const emps:any[]=empR.data||[];
    setFlotaTercero((vtR.data||[]).map((v:any)=>({...v,empresa_nombre:emps.find((e:any)=>e.id===v.empresa_id)?.razon_social||"Empresa tercerizada"})));
    // Las plantillas del PDF y sus reglas. Una lectura que falla NO es una lista vacía: se dice y
    // el formulario usa la corporativa, como antes. Las condiciones de un formulario sin tocar
    // salen de la plantilla (`considAuto`); las tocadas o las de una cotización abierta no se pisan.
    setPlantillas(plR.plantillas);setReglasPl(plR.ok?plR.reglas:null);setLecturaPl({cargada:true,error:plR.ok?null:plR.error,sinDiseno:plR.sinDiseno});
    setLoading(false);
  };
  useEffect(()=>{cargarResto();},[]);
  // Volver a la pestaña relee las plantillas (pudieron editarse en Plantillas PDF). Una relectura que
  // falla no borra lo que ya había.
  useEffect(()=>{
    let vivo=true;
    const alVolver=()=>{if(document.visibilityState!=="visible")return;leerPlantillasYReglas(supabase).then(r=>{if(!vivo||!r.ok)return;setPlantillas(r.plantillas);setReglasPl(r.reglas);setLecturaPl({cargada:true,error:null,sinDiseno:r.sinDiseno});}).catch(()=>{});};
    document.addEventListener("visibilitychange",alVolver);
    return()=>{vivo=false;document.removeEventListener("visibilitychange",alVolver);};
  },[]);
  /**
   * Tras guardar, duplicar, convertir, eliminar o cambiar el estado: solo lo que esas acciones
   * cambian. La lista; el historial de los selectores («Recientes»), y el tarifario, que guardar y
   * aprobar escriben. Clientes, flota, parámetros y plantilla no cambian por ellas y se leen al
   * montar: releerlos dejaba los selectores de unidad en «cargando».
   */
  const refrescar=async()=>{
    leerHistorialSelector(supabase,hoyLimaISO()).then(setHistorialSel).catch(()=>{});
    supabase.from("tarifario").select("*").eq("activo",true)
      .then(({data,error}:{data:Tarifa[]|null;error:unknown})=>{if(!error&&data)setTarifas(data);},()=>{});
    await cargarLista();
  };
  // Elegir cliente = lo que hacía el onChange del <select>: guarda el id como texto y propone el IGV por tipo.
  const aplicarCliente=(cl:ClienteBuscable|null)=>setForm(p=>({...p,cliente_id:cl?String(cl.id):"",incluye_igv:cl?.tipo==="b2b"?true:false}));
  // Solo los del cliente que está puesto ahora: los de un cliente anterior no se enseñan ni un instante.
  const contactosCl=contactosDe.id===form.cliente_id?contactosDe.lista:[];
  const usoCl=useMemo(()=>usoPorCliente(historialSel),[historialSel]);
  const recientesCl=useMemo(()=>recientesDe(historialSel,8),[historialSel]);
  // Buscadores de unidad: uso y recientes derivados de las cotizaciones (no se guarda nada).
  const usoVehP=useMemo(()=>usoPorVehiculo(historialSel,"vehiculo_flota_id"),[historialSel]);
  const recVehP=useMemo(()=>recientesVehiculos(historialSel,"vehiculo_flota_id",8),[historialSel]);
  const usoVehT=useMemo(()=>usoPorVehiculo(historialSel,"vehiculo_tercero_id"),[historialSel]);
  const recVehT=useMemo(()=>recientesVehiculos(historialSel,"vehiculo_tercero_id",8),[historialSel]);
  // ── Búsqueda y filtros en memoria, con el MISMO motor (lib/cotizaciones-filtros.ts) ──
  const mapaClientes=useMemo(()=>new Map(clientes.map(c=>[c.id,c])),[clientes]);
  const textos=useMemo(()=>new Map(cotizas.map(c=>[c.id,textoBuscable(c,mapaClientes.get(c.cliente_id??-1))])),[cotizas,mapaClientes]);
  const terminosCot=useMemo(()=>terminosBusqueda(busquedaDeb),[busquedaDeb]);
  const filtradas=useMemo(()=>filtrarLista(cotizas,textos,{terminos:terminosCot,estado:filtroEst,modo:filtroModo}),[cotizas,textos,terminosCot,filtroEst,filtroModo]);
  // KPIs: el periodo filtrado solo por modo (ni por estado ni por búsqueda: si no, «Pendientes» con el filtro «Aprobadas» daría 0).
  const kpis=useMemo(()=>kpisDe(filtrarLista(cotizas,textos,{terminos:[],estado:"todos",modo:filtroModo})),[cotizas,textos,filtroModo]);
  // Cuántas filas se pintan: vuelve a PASO_LISTA al cambiar cualquier filtro o la búsqueda.
  const clavePaginado=`${claveLista}|${busquedaDeb}|${filtroEst}|${filtroModo}`;
  const nVisibles=paginado.clave===clavePaginado?paginado.n:PASO_LISTA;
  const mostrarMas=()=>setPaginado({clave:clavePaginado,n:nVisibles+PASO_LISTA});
  /**
   * Pide la cotización COMPLETA antes de una acción que la necesita (editar, duplicar, PDF, ficha,
   * convertir). Si no se puede leer, NO se abre nada con campos vacíos: guardar ese formulario
   * borraría ítems y paraderos.
   *
   * Duplicar y convertir ESCRIBEN: su bandera dura hasta que la acción termina, no solo la lectura.
   * Antes se soltaba al leer, así que con la red lenta quedaban sin bloqueo y un segundo clic
   * insertaba otra copia u otras reservas. Editar, PDF y ficha solo abren algo: la bandera se
   * suelta al tener el detalle, como siempre (la ficha lleva la suya, y una consulta lenta a Google
   * no tiene por qué bloquear el resto de la lista).
   */
  const conDetalle=async(c:CotFila,accion:string,hacer:(d:Cotizacion)=>unknown)=>{
    if(accionEnCursoRef.current)return;
    accionEnCursoRef.current=true;setDetalleCargando({id:c.id,accion});
    const soltar=()=>{accionEnCursoRef.current=false;setDetalleCargando(null);};
    const n=c.numero_cotizacion||String(c.id).padStart(5,"0");
    let d=cacheDetalle.current.get(c.id);
    if(!d){
      try{
        const leida=await leerCotizacion<Cotizacion>(supabase,c.id);
        if(!leida){soltar();alert(`La cotización #${n} ya no existe (pudo eliminarse). Se recarga la lista.`);cargarLista();return;}
        d=leida;cacheDetalle.current.set(c.id,d);
      }catch(e){
        soltar();
        alert(`No se pudo abrir la cotización #${n}: ${(e as {message?:string})?.message||String(e)}\nNo se abrió nada para no trabajar con datos incompletos. Inténtalo de nuevo.`);
        return;
      }
    }
    const escribe=ACCIONES_QUE_ESCRIBEN.has(accion);
    if(!escribe)soltar();
    try{await hacer(d);}
    catch(e){
      alert(`⚠️ No se pudo terminar la acción sobre la cotización #${n}: ${(e as {message?:string})?.message||String(e)}. Revisa la lista${accion==="reserva"?" y Programación":""} antes de volver a intentarlo: pudo quedar a medias.`);
    }finally{if(escribe)soltar();}
  };
  const cargandoEsta=(id:number,accion:string)=>detalleCargando?.id===id&&detalleCargando.accion===accion;
  const abrirAltaCliente=(texto:string)=>{
    const t=texto.trim();const dig=t.replace(/\s+/g,"");
    const qs=/^\d{8}(\d{3})?$/.test(dig)?`&doc=${encodeURIComponent(dig)}`:t?`&nombre=${encodeURIComponent(t)}`:"";
    esperaClienteRef.current=true;window.open(`/clientes?nuevo=1${qs}`,"_blank","noopener");
  };
  // Alta en la otra pestaña → recargar la lista; seleccionar solo si esta pantalla lo pidió y el id llegó.
  // Volver a la pestaña también recarga (sin autoseleccionar): pudo editarse o crearse sin el canal.
  useEffect(()=>{
    let vivo=true;
    const recargar=async()=>{const l=await leerClientes();if(vivo&&l)setClientes(l);return vivo?l:null;};
    let canal:BroadcastChannel|null=null;
    try{if(typeof BroadcastChannel!=="undefined"){canal=new BroadcastChannel("afa-clientes");canal.onmessage=async(ev)=>{
      const m=ev.data;if(!m||m.tipo!=="creado"||typeof m.id!=="number"||!Number.isFinite(m.id))return;
      const l=await recargar();if(!l||!esperaClienteRef.current)return;
      const cl=l.find(c=>c.id===m.id);if(!cl)return;
      esperaClienteRef.current=false;aplicarCliente(cl);
    };}}catch{/* sin canal, basta con volver a la pestaña */}
    const alVolver=()=>{if(document.visibilityState==="visible")recargar();};
    document.addEventListener("visibilitychange",alVolver);
    return()=>{vivo=false;document.removeEventListener("visibilitychange",alVolver);try{canal?.close();}catch{}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // Contactos del cliente elegido, como atajo para «Atención». Best-effort: si falla, no se muestra nada.
  useEffect(()=>{
    const clave=form.cliente_id,id=Number(clave);if(!clave||!Number.isFinite(id))return;
    let vigente=true;
    supabase.from("contactos").select("nombre,apellido,cargo,telefono,email,principal").eq("cliente_id",id).order("principal",{ascending:false}).order("nombre")
      .then(({data,error}:{data:ContactoCl[]|null;error:unknown})=>{if(vigente&&!error)setContactosDe({id:clave,lista:(data||[]).filter(c=>String(c.nombre??"").trim())});},()=>{});
    return()=>{vigente=false;};
  },[form.cliente_id]);

  // Restaurar borrador al montar
  useEffect(()=>{
    try{
      const raw=localStorage.getItem(DRAFT_KEY);if(!raw)return;
      const d=JSON.parse(raw);if(!d?.form)return;
      skipDescRef.current=true;skipParadasRef.current=true;
      // Sobre FORM0: un borrador de una versión anterior no trae los campos nuevos, y un `.trim()`
      // sobre uno ausente reventaba el guardado — y el borrador sobrevive a F5.
      setForm({...FORM0,...d.form});
      if(d.items?.length)setItems(d.items);
      // Los ítems del borrador están en la moneda en que se teclearon (`monedaItems`), con su TC.
      if(d.monedaItems==="USD"&&typeof d.tcItems==="number"){setMonedaItems("USD");setUltimoTc(d.tcItems);}
      // Plantilla y condiciones (borrador con `vPlantillas`): la elegida o guardada, y las condiciones
      // solo si alguien las tocó (`considEditada`; null = las de la plantilla). Un borrador de ANTES
      // trae siempre `consid`: si editaba una cotización, se vuelve a leer para cargar lo que su PDF
      // imprime hoy (fijarConsidDeCotizacion), salvo que se hubieran editado.
      if(d.vPlantillas){
        if(d.plantillaFijada&&typeof d.plantillaFijada.id==="string")setPlantillaFijada(d.plantillaFijada);
        if(d.considEditada)setConsidEditada(d.considEditada);
        idiomaTocadoRef.current=!!d.idiomaTocado;
      }else{
        idiomaTocadoRef.current=d.form.idioma_pdf==="en";
        if(d.editandoId){
          setConsidPendiente(true);
          leerCotizacion<Cotizacion>(supabase,d.editandoId).then(c=>{if(c)fijarConsidDeCotizacion(c,d.consid??null);else{if(d.consid)setConsidEditada(d.consid);setConsidPendiente(false);}},()=>{if(d.consid)setConsidEditada(d.consid);setAvisoConsidForm("No se pudo leer la cotización de este borrador: revisa las condiciones y la plantilla antes de guardar.");setConsidPendiente(false);});
        }else if(d.consid)setConsidEditada(d.consid);
      }
      if(d.paradas?.length)setParadas(d.paradas);
      if(d.paradasRetorno?.length)setParadasRetorno(d.paradasRetorno);
      restaurarRuta({...d.form,ruta_coords_json:d.rutaCoords,paradas_json:d.paradas});
      if(d.fechasMultidia?.length)setFechasMultidia(d.fechasMultidia);
      if(d.editandoId)setEditandoId(d.editandoId);
      if(d.diasCond)setDiasCond(d.diasCond);
      if(d.peajesF)setPeajesF(d.peajesF);
      if(d.pernocteF)setPernocteF(d.pernocteF);
      if(d.viaticosF)setViaticosF(d.viaticosF);
      setMostrarForm(true);setDraftRecuperado(true);
    }catch{}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // Guardar borrador mientras el formulario está abierto
  useEffect(()=>{
    if(!mostrarForm)return;
    if(!form.origen&&!form.destino&&!form.cliente_id&&!editandoId)return;
    const rutaCoords=rutaCoordsParaGuardar(origenPlace,destinoPlace,retornoPlace,{origen:form.origen,destino:form.destino,retorno:form.punto_retorno},vuelve);
    try{localStorage.setItem(DRAFT_KEY,JSON.stringify({form,items,monedaItems,tcItems:monedaItems==="USD"?ultimoTc:null,vPlantillas:1,considEditada,plantillaFijada,plantillaForm,idiomaTocado:idiomaTocadoRef.current,paradas,paradasRetorno,fechasMultidia,editandoId,diasCond,peajesF,pernocteF,viaticosF,rutaCoords,savedAt:new Date().toISOString()}));}catch{}
  },[form,items,monedaItems,ultimoTc,considEditada,plantillaFijada,plantillaForm,paradas,paradasRetorno,mostrarForm,editandoId,diasCond,peajesF,pernocteF,viaticosF,origenPlace,destinoPlace,retornoPlace,vuelve]);

  // Auto-construir descripción del primer ítem cuando cambia modo/tipo/equipamiento
  useEffect(()=>{
    if(!mostrarForm)return;
    if(skipDescRef.current){skipDescRef.current=false;return;}
    // Compuesta por lib/cotizacion-idioma.ts en el idioma del PDF. El nivel lo declara la FICHA
    // (sufijo _ESTANDAR), no `form.equipamiento`: elegir una placa copia el equipamiento de la PLACA
    // y puede contradecir a la ficha. Y si el nombre de la ficha ya lo dice, no se repite.
    const tipoNom=paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo)?.nombre||"";
    const autoDesc=descripcionServicio({modo_servicio:form.modo_servicio,tipo_vehiculo:form.tipo_vehiculo,tipoNombre:tipoNom},form.idioma_pdf);
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

  // ── NIVEL DE SERVICIO ───────────────────────────────────────────────────────
  // El nivel se DERIVA de `form.equipamiento`, que es lo que se guarda: un estado propio al lado
  // sería un segundo sitio donde vive la misma decisión, que es el bug que esto viene a cerrar.
  const nivel=nivelDeEquipamiento(form.equipamiento);
  const [avisoNivel,setAvisoNivel]=useState("");

  /** El selector de «Vehículo de tarifa» solo ofrece las fichas del nivel elegido. */
  const fichasNivel=useMemo(()=>fichasDelNivel(paramsDB,nivel),[paramsDB,nivel]);
  const gruposVeh=useMemo(()=>{const m:Record<string,ParamCosto[]>={};fichasNivel.forEach(v=>{const g=v.grupo_vehiculo||"Otros";if(!m[g])m[g]=[];m[g].push(v);});return m;},[fichasNivel]);

  /** Cambiar de nivel arrastra la ficha a su gemela; `planDeNivel` declara el motivo si no puede. */
  const cambiarNivel=(n:NivelServicio)=>{
    const plan=planDeNivel(form.tipo_vehiculo,n,paramsDB);
    setForm(p=>({...p,equipamiento:equipamientoDeNivel(n),
      ...(plan.codigo==="cambia"||plan.codigo==="sin_gemela"||plan.codigo==="nivel_vacio"?{tipo_vehiculo:plan.clave||""}:{})}));
    setAvisoNivel(plan.codigo==="sin_gemela"||plan.codigo==="nivel_vacio"?plan.detalle:"");
  };

  /** Elegir una ficha declara su nivel: nunca queda un nivel que contradiga a la unidad de tarifa. */
  const elegirFicha=(clave:string)=>{
    setForm(p=>({...p,tipo_vehiculo:clave,equipamiento:equipamientoDeNivel(nivelDeFicha(clave))}));
    setAvisoNivel("");
  };

  /**
   * La PLACA contra el nivel. Solo se juzga la flota propia: `vehiculos_tercero` no tiene columna
   * `equipamiento`, así que de 86 unidades no hay dato y afirmar ahí sería inventar.
   */
  const cotejoUnidad=useMemo(()=>{
    const propia=form.vehiculo_flota_id?flota.find(v=>v.id===Number(form.vehiculo_flota_id)):null;
    return cotejarUnidadConNivel(propia?.equipamiento,nivel,!!propia);
  },[form.vehiculo_flota_id,flota,nivel]);
  const updItem=(i:number,k:keyof ItemCot,v:string|number)=>setItems(p=>p.map((it,idx)=>idx===i?{...it,[k]:Number.isNaN(Number(v))?v:Number(v)}:it));
  const addItem=()=>setItems(p=>[...p,{...ITEM_VACIO}]);const delItem=(i:number)=>setItems(p=>p.filter((_,idx)=>idx!==i));
  const faltaColMoneda=sinColumnasLista.includes("moneda")||faltaMonedaGuardado;
  const revTc=revisarTipoCambio(form.tipo_cambio);
  /** El tipo de cambio con que se expresan hoy los importes del formulario (null = soles). */
  const tcItems=monedaItems==="USD"?(revTc.tc??ultimoTc):null;
  /** Los ítems del formulario EN SOLES (lo que se guarda): 4 decimales desde los dólares tecleados. */
  const itemsPENForm=useMemo(()=>monedaItems==="USD"?(itemsAPEN(items,"USD",tcItems)??items):items,[items,monedaItems,tcItems]);
  /** Precio/día del formulario en soles (con IGV), o null si está vacío. */
  const precioDiaPENForm=(()=>{const n=Number(form.precio_dia);if(!form.precio_dia||!Number.isFinite(n)||n<=0)return null;return monedaItems==="USD"?aPENdesdeCot(n,"USD",tcItems):n;})();
  // Totales en SOLES (lo que se guarda en precio_cliente) y en la moneda que se enseña.
  const totPEN=totalesEnMoneda(itemsPENForm,"PEN",null,form.incluye_igv)!;
  const totPant=(monedaItems==="USD"?totalesEnMoneda(itemsPENForm,"USD",tcItems,form.incluye_igv):null)??totPEN;
  const{subtotal}=totPEN;const{igv,total}=totPant;const subtotalPant=totPant.subtotal;
  const simbItems=simboloMoneda(monedaItems);

  /** Lleva ítems y precio/día a la moneda pedida, si se puede (ver `monedaItems`). */
  const reexpresar=(m:Moneda,tcStr:string)=>{
    const r=revisarTipoCambio(tcStr);
    if(r.codigo==="ok")setUltimoTc(r.tc);
    if(m==="USD"&&monedaItems==="PEN"&&r.tc!=null){
      const tc=r.tc;
      const usd=itemsEnMoneda(items,"USD",tc)??items;
      const pd=form.precio_dia&&Number(form.precio_dia)>0?String(aMonedaCot(Number(form.precio_dia),"USD",tc)):form.precio_dia;
      baseSolesRef.current={tc,usd:JSON.stringify({usd,pd}),items,precioDia:form.precio_dia};
      setItems(usd);setForm(p=>({...p,precio_dia:pd}));setMonedaItems("USD");
    }else if(m==="PEN"&&monedaItems==="USD"){
      const tc=r.tc??ultimoTc;
      const base=baseSolesRef.current;
      if(base&&base.tc===tc&&base.usd===JSON.stringify({usd:items,pd:form.precio_dia})){
        setItems(base.items);setForm(p=>({...p,precio_dia:base.precioDia}));
      }else if(tc!=null){
        setItems(itemsAPEN(items,"USD",tc)??items);
        const pd=form.precio_dia&&Number(form.precio_dia)>0?String(aPENdesdeCot(Number(form.precio_dia),"USD",tc)):form.precio_dia;
        setForm(p=>({...p,precio_dia:pd}));
      }
      baseSolesRef.current=null;setMonedaItems("PEN");
    }
  };
  /** Cambiar la moneda NO reinterpreta números: los soles se conservan (planCambioMoneda). */
  const cambiarMoneda=(m:Moneda)=>{
    if(m===form.moneda)return;
    if(m==="USD"&&faltaColMoneda)return;
    setForm(p=>({...p,moneda:m}));
    reexpresar(m,form.tipo_cambio);
  };
  /** Con dólares ya en pantalla, cambiar el TC conserva los dólares tecleados y recalcula los soles. */
  const cambiarTipoCambio=(v:string)=>{
    setForm(p=>({...p,tipo_cambio:v}));
    reexpresar(form.moneda,v);
  };
  /** Una cotización en dólares sin un tipo de cambio válido no se guarda (lo que le falta, dicho). */
  const bloqueoMoneda=form.moneda!=="USD"?"":faltaColMoneda?`No se puede guardar en dólares: falta correr ${SQL_MONEDA}. Pásala a soles para guardarla.`:revTc.codigo!=="ok"?revTc.detalle:monedaItems!=="USD"?"Los importes todavía están en soles: escribe el tipo de cambio para pasarlos a dólares.":"";
  const detalleMoneda=planCambioMoneda({moneda:monedaItems,tipoCambio:form.tipo_cambio,itemsPEN:[]},form.moneda).detalle;
  // La sugerencia del tipo de cambio se pide al pasar a dólares (best-effort, nunca lanza).
  useEffect(()=>{
    if(form.moneda!=="USD"||sugTc)return;
    let vigente=true;
    leerTipoCambioSugerido(supabase,hoyLima()).then(r=>{if(vigente)setSugTc(r);});
    return()=>{vigente=false;};
  },[form.moneda,sugTc]);
  /** Al cambiar de idioma, la descripción automática se recompone (solo si sigue siendo la del sistema). */
  const cambiarIdiomaPdf=(i:Idioma)=>{
    if(i===form.idioma_pdf)return;
    const ctx={modo_servicio:form.modo_servicio,tipo_vehiculo:form.tipo_vehiculo,tipoNombre:paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo)?.nombre||""};
    const antes=descripcionServicio(ctx,form.idioma_pdf);
    setItems(prev=>prev.map((it,ix)=>ix===0&&it.descripcion===antes?{...it,descripcion:descripcionServicio(ctx,i)}:it));
    setForm(p=>({...p,idioma_pdf:i}));
  };
  // Una plantilla en INGLÉS preselecciona el PDF en inglés, y al pasar a una en español vuelve el
  // español que ella puso. Solo en una cotización nueva y mientras nadie haya elegido el idioma a mano.
  useEffect(()=>{
    if(editandoId!=null||idiomaTocadoRef.current||!filaForm||idiomaAplicadoRef.current===filaForm.id)return;
    const quiere:Idioma=normalizarIdioma(filaForm.idioma)==="en"?"en":"es";
    if(quiere==="en"&&faltaColMoneda)return; // sin cotizaciones-04 el PDF no se guarda en inglés
    idiomaAplicadoRef.current=filaForm.id;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sigue a la plantilla que eligió la regla (estado derivado de la base)
    if(quiere!==form.idioma_pdf)cambiarIdiomaPdf(quiere);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[filaForm?.id,filaForm?.idioma,editandoId,faltaColMoneda]);
  const limpiar=()=>{fijarDespachoOrigen(null);setForm(FORM0);setItems([{...ITEM_VACIO}]);setMonedaItems("PEN");baseSolesRef.current=null;/* plantilla por regla y condiciones sin tocar: las de la plantilla del formulario */setPlantillaFijada(null);setConsidEditada(null);reqConsidRef.current++;setConsidPendiente(false);setAvisoConsidForm("");idiomaTocadoRef.current=false;idiomaAplicadoRef.current=null;setParadas([]);setParadasRetorno([]);setFechasMultidia([]);setEditandoId(null);setMostrarForm(false);setDiasCond(1);setPeajesF(0);setPernocteF(0);setViaticosF(0);setOrigenPlace(null);setDestinoPlace(null);setRetornoPlace(null);setKmCongelado(null);setPorGeocodificar([]);setGeoFallo([]);setKmBase(null);setKmRet(null);setAvisoRet("");setCalculandoKm(false);setErrorKm("");setVehExpandido(false);setDraftRecuperado(false);esperaClienteRef.current=false;try{localStorage.removeItem(DRAFT_KEY);}catch{}window.scrollTo({top:0,behavior:"smooth"});};

  const selVeh=(id:string)=>{setForm(p=>({...p,vehiculo_flota_id:id,vehiculo_tercero_id:""}));if(!id)return;const v=flota.find(v=>v.id===Number(id));if(!v)return;setForm(p=>({...p,vehiculo_flota_id:id,vehiculo_tercero_id:"",equipamiento:v.tipo_vehiculo_costeo?equipamientoDeNivel(nivelDeFicha(v.tipo_vehiculo_costeo)):(v.equipamiento||"full_equipo"),tipo_vehiculo:v.tipo_vehiculo_costeo||p.tipo_vehiculo}));};
  const selVehTercero=(id:string)=>{setForm(p=>({...p,vehiculo_tercero_id:id,vehiculo_flota_id:""}));if(!id)return;const v=flotaTercero.find(v=>v.id===Number(id));if(!v)return;setForm(p=>({...p,vehiculo_tercero_id:id,vehiculo_flota_id:"",tipo_vehiculo:v.tipo_vehiculo_costeo||p.tipo_vehiculo,...(v.tipo_vehiculo_costeo?{equipamiento:equipamientoDeNivel(nivelDeFicha(v.tipo_vehiculo_costeo))}:{})}));};
  // `sinIGV` llega en SOLES (el calculador y el tarifario son soles); se escribe en la moneda en que
  // se teclean hoy los ítems. El costo interno sigue en soles.
  const aplicarPrecio=(sinIGV:number,fuente:string,costoBase?:number)=>{const esFijo=form.modo_servicio==="fijo";const conIGV=sinIGV*(1+IGV);const enPant=(pen:number)=>monedaItems==="USD"?(aMonedaCot(pen,"USD",tcItems)??Math.round(pen*100)/100):Math.round(pen*100)/100;setItems(prev=>{const n=[...prev];n[0]={...n[0],precio_unit:enPant(sinIGV)};return n;});if(costoBase)setForm(p=>({...p,costo_estimado:String(Math.round(costoBase*100)/100)}));if(esFijo)setForm(p=>({...p,precio_dia:String(enPant(conIGV))}));};
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
    // Todo lo que se escribe va EN SOLES: los ítems y el precio/día tecleados en US$ se llevan a
    // soles con 4 decimales al tipo de cambio de la cotización (lib/cotizacion-moneda.ts).
    const precioDiaNum=esFijo?precioDiaPENForm||costoCalc?.diaEstIGV:null;
    const precioMesNum=esFijo&&precioDiaNum?precioDiaNum*26:null;
    const tot=totPEN.total;
    const monGuardar:Moneda=monedaItems==="USD"&&form.moneda==="USD"?"USD":"PEN";
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
      descuento_pct:Number(form.descuento_pct||0),items_json:itemsPENForm,tipo_vehiculo:form.tipo_vehiculo||null,
      tipo_servicio:form.tipo_servicio||null,equipamiento:form.equipamiento||null,
      vehiculo_flota_id:form.vehiculo_flota_id?Number(form.vehiculo_flota_id):null,
      vehiculo_tercero_id:form.vehiculo_tercero_id?Number(form.vehiculo_tercero_id):null,
      // Las condiciones quedan ESCRITAS en la fila (versión 2): el PDF imprime estas, las que muestra
      // el formulario, y no las que tenga la plantilla el día que se imprima (lib/cotizacion-plantillas.ts).
      consideraciones_json:{incluye:consid.incluye,no_incluye:consid.no_incluye,generales:consid.generales,...(Array.isArray(consid.reserva)?{reserva:consid.reserva}:{}),...(Array.isArray(consid.reserva)&&Array.isArray(consid.reserva_resumen)?{reserva_resumen:consid.reserva_resumen}:{}),version:CONSID_VERSION,plantilla:plantillaForm},plantilla_pdf:plantillaForm,
      paradas_json:paradas.length>0?paradas:null,paradas_retorno_json:paradasRetorno.length>0?paradasRetorno:null,modo_servicio:form.modo_servicio,
      dias_servicio:Number(form.dias_servicio)||1,horas_servicio:Number(form.horas_servicio)||8,
      pernocte_costo:pernocteF||null,precio_dia:precioDiaNum,precio_mes_estimado:precioMesNum,
      precio_tarifario:tarifaEnc?tarifaEnc.precio:null,
      precio_cotizador:esFijo?(costoCalc?.diaEstIGV||null):(costoCalc?.totalEst20||null),
      costo_cotizador:costoCalc?.baseCosto||null,margen_cotizador:20,vehiculo_cotizador:vehParam?.nombre||null,
      precio_sugerido:costoCalc?(esFijo?costoCalc.diaEstIGV:costoCalc.totalEst20):null,
      modo_precio:tarifaEnc?"tarifario":"cotizador",incluye_igv:form.incluye_igv,
      itinerario_texto:form.itinerario_texto.trim()||null,
      moneda:monGuardar,tipo_cambio:monGuardar==="USD"?revTc.tc:null,idioma_pdf:form.idioma_pdf,
      ruta_coords_json:rutaCoordsParaGuardar(origenPlace,destinoPlace,retornoPlace,{origen:form.origen,destino:form.destino,retorno:form.punto_retorno},!esSoloIda),
    } as any;
  };

  /**
   * Guarda la cotización. `ruta_coords_json` es de una migración accesoria
   * (supabase/cotizaciones-02-ruta-coords.sql): sin ella se guarda igual y la pantalla lo DICE —
   * las coordenadas no se perderían en silencio.
   */
  const escribirCotizacion=async(payload:Record<string,unknown>)=>{
    // SEGURIDAD (comisiones-05): vendedor_id es INMUTABLE una vez puesto. El motor atribuye
    // TODA comisión por él, así que editar una cotización NO lo reescribe — reatribuiría la
    // comisión al editor. Solo viaja en la creación (INSERT); se suelta en el UPDATE.
    // En la creación se pide .select("id").single() para poder vincular el servicio del Despachador.
    const ir=(p:Record<string,unknown>):Promise<any>=>{
      if(editandoId){const{vendedor_id:_omitido,...sinVendedor}=p;return supabase.from("cotizaciones").update(sinVendedor).eq("id",editandoId) as any;}
      return supabase.from("cotizaciones").insert(p).select("id").single() as any;
    };
    // Columnas accesorias: si falta la migración se suelta SOLO la que el error nombra y se reintenta.
    // ruta_coords_json → cotizaciones-02-ruta-coords.sql · vendedor_id → comisiones-02-captador-y-vendedor.sql.
    const intento={...payload};
    let r=await ir(intento);
    let guard=0;
    // moneda/tipo_cambio/idioma_pdf → cotizaciones-04-moneda-idioma.sql: sin ella se guarda en soles
    // y en español. Una cotización en DÓLARES no se guarda así: se dice y se devuelve el error.
    while(r.error&&guard++<5){
      const col=(["ruta_coords_json","vendedor_id",...COLS_MONEDA] as const).find(c=>c in intento&&faltaColumna(r.error,c));
      if(!col)break;
      if((COLS_MONEDA as readonly string[]).includes(col)){
        setFaltaMonedaGuardado(true);
        if(intento.moneda==="USD")return{error:{message:`No se guardó: la cotización está en dólares y la base todavía no tiene la columna «${col}». Hay que correr ${SQL_MONEDA}; mientras tanto se puede cotizar en soles.`}} as any;
        for(const c of COLS_MONEDA)delete intento[c];
      }else delete intento[col];
      if(col==="ruta_coords_json")setFaltaMigracionCoords(true);
      r=await ir(intento);
    }
    return r;
  };

  /**
   * Quién guarda: el nombre (para «REPRESENTANTE») y el id (para `vendedor_id`). Sale de
   * `getSession`, que lee la sesión del almacén LOCAL; antes cada guardado sin nombre resuelto
   * pedía `getUser()`, que es un viaje al servidor de Auth con el candado de sesión tomado.
   */
  const operadorActual=async():Promise<{nombre:string;id:string|null}>=>{
    const{data:{session}}=await supabase.auth.getSession();
    const u=session?.user;
    let nombre=reprNombre||"";
    if(!nombre&&u){
      try{
        type FilaNombre={data:{nombre?:string|null}|null};
        const{data:porId}:FilaNombre=await supabase.from("usuarios").select("nombre").eq("id",u.id).maybeSingle();
        let n=String(porId?.nombre??"").trim();
        if(!n&&u.email){const{data:porCorreo}:FilaNombre=await supabase.from("usuarios").select("nombre").eq("email",u.email).maybeSingle();n=String(porCorreo?.nombre??"").trim();}
        if(n)nombre=extraerNombreApellido(n);
      }catch(e){/* best-effort: sin nombre, el PDF omite la línea */}
    }
    return{nombre,id:u?.id??null};
  };
  /** Lo que salga mal a mitad de un guardado se DICE, y el botón vuelve a quedar usable (finally). */
  const avisarFalloGuardado=(e:unknown)=>alert(`⚠️ No se pudo terminar de guardar: ${(e as {message?:string})?.message||String(e)}. Revisa la lista antes de volver a intentarlo: la cotización pudo quedar guardada.`);

  const guardarBorrador=async()=>{
    if(calculandoKm){alert("⏳ Se está calculando el kilometraje de la ruta. Espera un segundo antes de guardar.");return;}
    if(!lecturaPl.cargada||considPendiente){alert("⏳ Se están leyendo las plantillas del PDF (de ellas salen las condiciones). Espera un segundo antes de guardar.");return;}
    if(!form.cliente_id&&!form.origen.trim()&&!form.destino.trim()){alert("⚠️ Ingresa al menos el cliente o la ruta para guardar el borrador");return;}
    if(bloqueoMoneda){alert(`⚠️ ${bloqueoMoneda}`);return;}
    setGuardando(true);
    try{
      const op=await operadorActual();
      const payload={...buildPayload("borrador"),creado_por:op.nombre||null,vendedor_id:op.id};
      const{error}=await escribirCotizacion(payload);
      if(error){alert(error.message);return;}
      limpiar();refrescar();
    }catch(e){avisarFalloGuardado(e);}
    finally{setGuardando(false);}
  };

  const guardarCotizacion=async()=>{
    // Mientras Maps responde, form.km puede ser el del destino anterior: no se guarda.
    if(calculandoKm){alert("⏳ Se está calculando el kilometraje de la ruta. Espera un segundo antes de guardar.");return;}
    if(!lecturaPl.cargada||considPendiente){alert("⏳ Se están leyendo las plantillas del PDF (de ellas salen las condiciones). Espera un segundo antes de guardar.");return;}
    if(!form.origen.trim()){alert("⚠️ Falta el Punto de origen");return;}
    if(!form.destino.trim()){alert("⚠️ Falta el Punto de destino");return;}
    if(!form.cliente_id){alert("⚠️ Falta seleccionar el cliente");return;}
    if(requiereParadas&&paradas.length<2){alert("⚠️ El servicio 'Con Paradas' requiere al menos 2 puntos del recorrido en la sección de paradas");return;}
    const cl=clientes.find(c=>c.id===Number(form.cliente_id));if(cl?.estado==="bloqueado"){alert("Cliente bloqueado.");return;}
    if(items.some(it=>!it.descripcion.trim())){alert("Todos los items necesitan descripción");return;}
    if(bloqueoMoneda){alert(`⚠️ ${bloqueoMoneda}`);return;}
    setGuardando(true);
    try{
    const op=await operadorActual();
    const esFijo=form.modo_servicio==="fijo";
    const payload={...buildPayload(form.estado==="borrador"?"pendiente":undefined),creado_por:op.nombre||null,vendedor_id:op.id};
    const{error,data:insertado}=await escribirCotizacion(payload);
    if(error){alert(error.message);return;}
    // Servicio del Despachador que se estaba cotizando: queda vinculado a la cotización nueva.
    const origenDesp=despachoOrigenRef.current;
    if(origenDesp&&!editandoId){
      const nuevoId=Number(insertado?.id);
      const v=Number.isFinite(nuevoId)&&nuevoId>0?await vincularCotizacion(supabase,origenDesp.id,nuevoId):{ok:false,error:"no se obtuvo el id de la cotización nueva"};
      if(!v.ok)alert(`La cotización se guardó, pero NO se pudo vincular al servicio del Despachador #${origenDesp.codigo||origenDesp.id}: ${v.error}. Vincúlalo desde «⚡ sin cotizar».`);
      fijarDespachoOrigen(null);contarDespacho();
    }
    // Capturar antes de limpiar() para la propagación
    const cotIdGuardado=editandoId;
    const paradasGuardadas=[...paradas];
    const paradasRetornoGuardadas=[...paradasRetorno];
    const tarifaEnc=buscarTarifa();const vehParam=paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo);
    const costoCalc=vehParam?calcCostoVeh(vehParam,preciosDB,kmNum>0?kmNum:1,diasCond,peajesF,pernocteF,viaticosF):null;
    const precioDiaNum=esFijo?precioDiaPENForm||costoCalc?.diaEstIGV:null;
    // El tarifario guarda SOLES (sin IGV), también desde una cotización en dólares.
    if(guardarTar&&form.tipo_vehiculo&&form.tipo_servicio&&form.equipamiento&&subtotal>0){const{error:tarErr}=await supabase.from("tarifario").upsert({origen:form.origen.trim().toUpperCase(),destino:form.destino.trim().toUpperCase(),tipo_vehiculo:form.tipo_vehiculo,equipamiento:form.equipamiento,tipo_servicio:form.tipo_servicio,modo:form.modo_servicio,precio:esFijo?(precioDiaNum||subtotal)/1.18:subtotal,moneda:"PEN",confidencial:["full_day","multi_dia"].includes(form.tipo_servicio),incluye_guia:false,incluye_peajes:false,incluye_alimentacion:false,notas:`Cotización ${form.numero_cotizacion||""}`.trim(),activo:true},{onConflict:"origen,destino,tipo_vehiculo,equipamiento,tipo_servicio"});if(tarErr)alert("Error al guardar en tarifario: "+tarErr.message);}
    // Detectar servicios futuros no ejecutados para ofrecer propagación de las direcciones.
    //
    // TRES COSAS DEJABAN SERVICIOS FUERA, y las tres en silencio — el operador veía "se
    // propagó" y una parte de sus servicios seguía con la dirección vieja:
    //
    // 1 · SOLO CORRÍA EN LOS FIJOS (`esFijo &&`). Una cotización eventual o multi-día también
    //     genera varios servicios desde la misma ficha, y ninguno recibía las paradas nuevas.
    //     Lo que decide si hay que propagar es tener paradas y servicios futuros, no el modo.
    // 2 · POSTGREST CORTA EN 1000 FILAS. Un contrato fijo largo pasa de ese techo, así que el
    //     select plano alcanzaba a los primeros 1000 y callaba el resto.
    // 2b· Y UN PAGINADO SIN ORDEN NO ES UN PAGINADO. `.range()` sobre un select sin
    //     `order` deja el orden a criterio de Postgres, que puede devolver las páginas
    //     solapadas: con más de 1000 servicios se repetían unos y se PERDÍAN otros, en
    //     silencio y sin patrón — justo lo que hace que "a algunos sí les llegó".
    // 3 · `.neq("estado", …)` EXCLUÍA LAS FILAS CON `estado` NULL. En SQL `estado <> 'x'` es
    //     NULL cuando el campo es NULL, y PostgREST descarta lo que no evalúa a true — así que
    //     los servicios sin estado escrito, que son servicios VIVOS y los que más falta hace
    //     tocar, quedaban fuera. El filtro se hace en JS, donde "no es ninguno de estos tres"
    //     significa lo que uno espera que signifique.
    //
    // Los servicios del contrato se leen UNA sola vez y de ahí salen las dos listas (propagar las
    // paradas y re-sincronizar el cliente). Antes eran dos lecturas paginadas de las MISMAS filas,
    // una detrás de la otra, con el botón en «Guardando…»: en un contrato fijo largo, segundos de más.
    //
    // Las dos columnas accesorias se sueltan SOLO si el error las nombra, y cada una apaga solo su
    // uso (como cuando eran dos lecturas): sin `direccion_servicio` no se propaga, sin
    // `estado_admin` no se re-sincroniza el cliente. Una lectura que falla por otra causa SE DICE:
    // antes se cortaba en silencio y el guardado parecía completo.
    const todayPeru=hoyLimaISO();
    const servCot:{id:number;direccion_servicio:string|null;estado:string|null;estado_admin:string|null;cliente_id:number|null;fecha_servicio:string|null}[]=[];
    const OPCIONALES_SERV=["direccion_servicio","estado_admin"] as const;
    const sinColServ:string[]=[];
    let falloLecturaServ="";
    if(cotIdGuardado){
      for(let d=0;d<40000;d+=1000){
        const cols=["id","estado","cliente_id","fecha_servicio",...OPCIONALES_SERV.filter(c=>!sinColServ.includes(c))].join(",");
        const{data,error:eLee}=await supabase.from("reservas").select(cols).eq("cotizacion_id",cotIdGuardado).order("id").range(d,d+999);
        if(eLee){
          const col=faltaAlguna(eLee,OPCIONALES_SERV.filter(c=>!sinColServ.includes(c)));
          if(col){sinColServ.push(col);servCot.length=0;d=-1000;continue;}
          falloLecturaServ=eLee.message||String(eLee);servCot.length=0;break;
        }
        servCot.push(...(data||[]));
        if(!data||data.length<1000)break;
      }
    }
    let reservasParaPropagar:{id:number;direccion_servicio:string|null}[]=[];
    if(cotIdGuardado&&!sinColServ.includes("direccion_servicio")&&(paradasGuardadas.length>0||paradasRetornoGuardadas.length>0)){
      // Mismo corte que el `.gte("fecha_servicio", hoy)` de antes: sin fecha no es un servicio futuro.
      reservasParaPropagar=servCot
        .filter(r=>(r.fecha_servicio??"")>=todayPeru&&!["en_curso","finalizada","cancelada"].includes(r.estado||""))
        .map(r=>({id:r.id,direccion_servicio:r.direccion_servicio}));
    }
    // ── Sincronizar el CLIENTE a los servicios ya generados desde esta cotización ──────────
    // cliente_id en una reserva es identidad HEREDADA de la cotización (se fija al generar el
    // servicio y jamás se re-sincroniza sola). Si aquí se cambió el cliente y no lo propagamos,
    // Programación seguiría mostrando el cliente viejo (bug reportado con la cotización #00238).
    // Se corrigen los servicios vinculados MENOS cancelados y ya facturados/cobrados (cambiarles
    // el cliente rompería la traza con el comprobante SUNAT ya emitido).
    let clientesResinc=0,clientesSinResinc=0;
    if(cotIdGuardado&&!sinColServ.includes("estado_admin")){
      const nuevoCliente=payload.cliente_id;
      const idsResinc=servCot.filter(r=>r.cliente_id!==nuevoCliente&&r.estado!=="cancelada"&&!["facturada","cobrada"].includes(r.estado_admin||"")).map(r=>r.id);
      // Se cuenta lo que de verdad se escribió: el aviso decía «actualizado en N» aunque un lote fallara.
      for(let i=0;i<idsResinc.length;i+=100){
        const lote=idsResinc.slice(i,i+100);
        const{error:eUpd}=await supabase.from("reservas").update({cliente_id:nuevoCliente}).in("id",lote);
        if(eUpd)clientesSinResinc+=lote.length;else clientesResinc+=lote.length;
      }
    }
    limpiar();refrescar();setGuardando(false);
    if(clientesResinc>0)alert(`✅ Cliente actualizado en ${clientesResinc} servicio${clientesResinc!==1?"s":""} de Programación vinculado${clientesResinc!==1?"s":""} a esta cotización.`);
    if(falloLecturaServ)alert(`⚠️ La cotización se guardó, pero no se pudieron revisar sus servicios de Programación (${falloLecturaServ}): ni se corrigió el cliente ni se ofrece propagar las paradas. Ábrela y guárdala de nuevo para reintentarlo.`);
    if(clientesSinResinc>0)alert(`⚠️ La cotización se guardó, pero ${clientesSinResinc} servicio${clientesSinResinc!==1?"s":""} de Programación siguen con el cliente anterior (no se pudieron actualizar). Ábrela y guárdala de nuevo para reintentarlo.`);
    if(reservasParaPropagar.length>0){
      setModalPropagar({cotId:cotIdGuardado!,reservas:reservasParaPropagar,paradasIda:paradasGuardadas,paradasRet:paradasRetornoGuardadas});
    }
    }catch(e){avisarFalloGuardado(e);}
    finally{setGuardando(false);}
  };

  const cambiarEstado=async(cot:CotFila,nEst:EstadoCot)=>{
    if(nEst===cot.estado)return;
    if(!TRANSICIONES[cot.estado].includes(nEst)){
      const sig=TRANSICIONES[cot.estado];
      alert(`No se puede pasar de "${ESTADO_CFG[cot.estado].label}" a "${ESTADO_CFG[nEst].label}".\nEl siguiente paso es: ${sig.length?sig.map(s=>ESTADO_CFG[s].label).join(" o "):"estado final"}.`);
      return;
    }
    if(nEst==="aprobado"){setModalAprob(cot);return;}
    if(nEst==="enviado"){setModalEnvio(cot);return;}
    await conBloqueoEstado(cot.id,async()=>{
      const e=await actualizarCot(cot.id,{estado:nEst});
      if(e){alert(`No se pudo pasar la cotización #${cot.numero_cotizacion||String(cot.id).padStart(5,"0")} a «${ESTADO_CFG[nEst].label}»: ${e}`);return;}
      refrescar();
    });
  };
  /**
   * Escribe en la cotización y devuelve el motivo si NO quedó escrita: con error, o sin ninguna fila
   * (eliminada, o sin permiso: la base no da error en ese caso). Antes no se miraba nada y una
   * escritura fallida dejaba creer que el estado cambió.
   */
  const actualizarCot=async(id:number,patch:Record<string,unknown>):Promise<string|null>=>{
    const{data,error}=await supabase.from("cotizaciones").update(patch).eq("id",id).select("id");
    if(error)return error.message;
    if(!data?.length)return "no se encontró la cotización (pudo eliminarse, o no tienes permiso para cambiarla)";
    return null;
  };
  /** Cambiar el estado, marcar enviada o aprobar: una escritura a la vez, y el botón bloqueado hasta que termine. */
  const conBloqueoEstado=async(id:number,hacer:()=>Promise<void>)=>{
    if(estadoEnCursoRef.current)return;
    estadoEnCursoRef.current=true;setEstadoEnCurso(id);
    try{await hacer();}
    catch(e){alert(`⚠️ No se pudo terminar de cambiar el estado: ${(e as {message?:string})?.message||String(e)}. Revisa la lista antes de volver a intentarlo.`);}
    finally{estadoEnCursoRef.current=false;setEstadoEnCurso(null);}
  };
  const confirmarEnvio=async(medio:string)=>{
    const cot=modalEnvio;if(!cot)return;
    await conBloqueoEstado(cot.id,async()=>{
      const e=await actualizarCot(cot.id,{estado:"enviado",medio_envio:medio});
      // Con error el modal sigue abierto: el medio elegido no se pierde y se puede reintentar.
      if(e){alert(`No se pudo marcar como enviada la cotización #${cot.numero_cotizacion||String(cot.id).padStart(5,"0")}: ${e}`);return;}
      setModalEnvio(null);refrescar();
    });
  };
  const confirmarAprob=async(tipo:string,numero:string)=>{
    const cot=modalAprob;if(!cot)return;
    await conBloqueoEstado(cot.id,async()=>{
      const e=await actualizarCot(cot.id,{estado:"aprobado",tipo_aprobacion:tipo,numero_aprobacion:numero});
      if(e){alert("Error al aprobar: "+e);return;}
      if(cot.tipo_vehiculo&&cot.tipo_servicio&&cot.equipamiento){const esFijo=cot.modo_servicio==="fijo";const{error:tarErr}=await supabase.from("tarifario").upsert({origen:cot.origen.toUpperCase(),destino:cot.destino.toUpperCase(),tipo_vehiculo:cot.tipo_vehiculo,equipamiento:cot.equipamiento,tipo_servicio:cot.tipo_servicio,modo:cot.modo_servicio||"eventual",precio:esFijo?(Number(cot.precio_dia||0)/1.18):Math.round(Number(cot.precio_cliente)/1.18*100)/100,moneda:"PEN",confidencial:false,incluye_guia:false,incluye_peajes:false,incluye_alimentacion:false,notas:`Aprobada #${cot.numero_cotizacion||cot.id}`,activo:true},{onConflict:"origen,destino,tipo_vehiculo,equipamiento,tipo_servicio"});if(tarErr)alert("Error al guardar en tarifario: "+tarErr.message);}
      setModalAprob(null);refrescar();
    });
  };
  /**
   * La bandera se suelta pase lo que pase: mientras propaga el modal no se puede cerrar, así que una
   * excepción a mitad lo dejaría colgado y sin salida.
   */
  const confirmarPropagar=async()=>{
    if(!modalPropagar||propagando)return;
    setPropagando(true);
    try{await propagarParaderos(modalPropagar);}
    catch(e){
      setModalPropagar(null);
      alert(`⚠ La propagación se interrumpió: ${(e as {message?:string})?.message||String(e)}.\nAlgunos servicios pudieron quedar actualizados: revisa Programación antes de volver a intentarlo.`);
    }finally{setPropagando(false);}
  };
  const propagarParaderos=async(mp:NonNullable<typeof modalPropagar>)=>{
    const{reservas,paradasIda,paradasRet}=mp;
    const todosIds=reservas.map(r=>r.id);
    const BATCH=100;

    // Qué reservas ya tienen paradas escaneadas. Por LOTES y con paginado, no en una consulta:
    // con un contrato largo `todosIds` pasa de mil, y un solo `.in()` arma una URL que revienta
    // y encima devuelve a lo más 1000 filas. Quedarse corto aquí es lo peligroso: una reserva
    // cuya actividad no se ve entra a `reservasAfectar` y se le pisan las paradas de un servicio
    // que YA se estaba prestando.
    const idsConActividad=new Set<number>();
    for(let i=0;i<todosIds.length;i+=BATCH){
      const lote=todosIds.slice(i,i+BATCH);
      for(let d=0;d<20000;d+=1000){
        const{data,error:eAct}=await supabase.from("paradas").select("reserva_id").in("reserva_id",lote).eq("estado","completada").order("id").range(d,d+999);
        // Una lectura fallida NO es «sin actividad»: seguir pisaría las paradas de un servicio en curso.
        if(eAct){setModalPropagar(null);setPropagando(false);alert("No se pudo comprobar qué servicios tienen paradas escaneadas, así que no se propagó nada: "+eAct.message);return;}
        (data||[]).forEach((p:any)=>idsConActividad.add(p.reserva_id));
        if(!data||data.length<1000)break;
      }
    }
    // Servicios con PASAJEROS asignados a sus paraderos: borrar y reinsertar las paradas los dejaría
    // sin paradero (o duplicaría el itinerario, según la clave foránea). Desde que los servicios de
    // hoy nacen con paraderos de madrugada (app/api/paradas/materializar), uno de hoy puede tener ya
    // pasajeros que eligieron su paradero. Si no se puede comprobar, no se propaga NADA.
    const idsConPasajeros=new Set<number>();
    try{
      const candidatos=reservas.filter(r=>!idsConActividad.has(r.id)).map(r=>r.id);
      for(let i=0;i<candidatos.length;i+=BATCH){
        const lote=candidatos.slice(i,i+BATCH);
        const paradaDe=new Map<number,number>();
        for(let d=0;;d+=1000){
          const{data,error}=await supabase.from("paradas").select("id,reserva_id").in("reserva_id",lote).order("id").range(d,d+999);
          if(error)throw new Error(error.message);
          (data||[]).forEach((p:any)=>paradaDe.set(Number(p.id),Number(p.reserva_id)));
          if(!data||data.length<1000)break;
        }
        const pids=[...paradaDe.keys()];
        for(let j=0;j<pids.length;j+=200){
          const trozo=pids.slice(j,j+200);
          for(let d=0;;d+=1000){
            const{data,error}=await supabase.from("pasajeros_parada").select("id,parada_id").in("parada_id",trozo).order("id").range(d,d+999);
            if(error)throw new Error(error.message);
            (data||[]).forEach((pp:any)=>{const rid=paradaDe.get(Number(pp.parada_id));if(rid!=null)idsConPasajeros.add(rid);});
            if(!data||data.length<1000)break;
          }
        }
      }
    }catch(e:any){
      setModalPropagar(null);setPropagando(false);
      alert("No se pudo comprobar qué servicios tienen pasajeros asignados, así que no se propagó nada: "+(e?.message||"error"));return;
    }

    // Qué se toca y qué no, con su motivo (lib/paradas-materializar.ts). Un retorno sin lista
    // propia ya NO recibe la de la ida: cada sentido tiene su paradero, y su hora.
    const plan=planDePropagacion(reservas,{ida:paradasIda,retorno:paradasRet},idsConActividad,idsConPasajeros);
    const idsIda=plan.ida,idsRet=plan.retorno,tramoRet=paradasRet;
    const fueraPor=(m:MotivoNoPropaga)=>plan.fuera.filter(f=>f.motivo===m).length;
    const lineasFuera=(Object.keys(MOTIVO_NO_PROPAGA) as MotivoNoPropaga[])
      .map(m=>[m,fueraPor(m)] as const).filter(([,n])=>n>0)
      .map(([m,n])=>`• ${n} sin tocar: ${MOTIVO_NO_PROPAGA[m]}`);
    const idsAfectar=[...idsIda,...idsRet];

    if(idsAfectar.length===0){
      setModalPropagar(null);setPropagando(false);
      alert(`Sin cambios — no quedó ningún servicio que propagar.\n${lineasFuera.join("\n")}`);return;
    }

    // Sincronizar origen/destino y hora de salida (copias denormalizadas que se muestran en
    // programación/seguimiento). La hora del servicio ES la del primer paradero de su tramo:
    // al reeditar los horarios en la cotización, reservas.hora_servicio se quedaba con la hora
    // vieja y Programación seguía mostrándola aunque los paraderos ya tuvieran la nueva.
    const syncOD=async(ids:number[],tramo:typeof paradasIda)=>{
      if(ids.length===0||tramo.length===0)return null;
      const od:Record<string,any>={origen:tramo[0].nombre,destino:tramo[tramo.length-1].nombre};
      const horaSalida=(tramo[0].hora||"").trim();
      if(horaSalida)od.hora_servicio=horaSalida;  // sin hora en el primer paradero no se pisa la actual
      const{error}=await supabase.from("reservas").update(od).in("id",ids);
      return error?error.message:null;
    };
    const filaDe=(rid:number,p:any,i:number)=>({reserva_id:rid,orden:i+1,nombre:p.nombre,direccion:p.direccion||null,lat:p.lat?Number(p.lat):null,lng:p.lng?Number(p.lng):null,hora_estimada:p.hora||null,estado:"pendiente"});
    const esRet=new Set(idsRet);

    // Lote por lote, y cada lote COMPLETO (semilla → borrar → insertar → origen/destino) antes del
    // siguiente. Borrar todo y después insertar todo dejaba segundos entre las dos cosas, y en ese
    // hueco el cron de la madrugada (o quien abriera el servicio) veía el servicio sin paraderos y
    // los creaba: al terminar, el itinerario quedaba DOBLE. Y justo antes de borrar se vuelve a
    // mirar si alguien eligió su paradero mientras tanto: ese servicio se salta.
    const LOTE_ESCRITURA=50;
    let hechos=0,conPasajerosTarde=0;const fallos:string[]=[];
    for(let i=0;i<idsAfectar.length;i+=LOTE_ESCRITURA){
      let lote=idsAfectar.slice(i,i+LOTE_ESCRITURA);
      const tomados=new Set<number>();
      try{
        const paradaDe=new Map<number,number>();
        for(let d=0;;d+=1000){
          const{data,error}=await supabase.from("paradas").select("id,reserva_id").in("reserva_id",lote).order("id").range(d,d+999);
          if(error)throw new Error(error.message);
          (data||[]).forEach((p:any)=>paradaDe.set(Number(p.id),Number(p.reserva_id)));
          if(!data||data.length<1000)break;
        }
        const pids=[...paradaDe.keys()];
        for(let j=0;j<pids.length;j+=200){
          for(let d=0;;d+=1000){
            const{data,error}=await supabase.from("pasajeros_parada").select("id,parada_id").in("parada_id",pids.slice(j,j+200)).order("id").range(d,d+999);
            if(error)throw new Error(error.message);
            (data||[]).forEach((pp:any)=>{const rid=paradaDe.get(Number(pp.parada_id));if(rid!=null)tomados.add(rid);});
            if(!data||data.length<1000)break;
          }
        }
      }catch(e:any){
        fallos.push(`No se pudo volver a comprobar los pasajeros (${e?.message||"error"}); se detuvo en el servicio ${i+1} de ${idsAfectar.length}.`);
        break;
      }
      conPasajerosTarde+=tomados.size;
      lote=lote.filter(id=>!tomados.has(id));
      if(lote.length===0)continue;
      const loteIda=lote.filter(id=>!esRet.has(id)),loteRet=lote.filter(id=>esRet.has(id));

      const eSemIda=loteIda.length?(await supabase.from("reservas").update({paradas_json:paradasIda}).in("id",loteIda)).error:null;
      const eSemRet=loteRet.length?(await supabase.from("reservas").update({paradas_json:tramoRet}).in("id",loteRet)).error:null;
      if(eSemIda||eSemRet){fallos.push(`${lote.length} servicio(s) sin tocar: no se pudo guardar su semilla (${(eSemIda||eSemRet)!.message}).`);continue;}

      const{error:eDel}=await supabase.from("paradas").delete().in("reserva_id",lote);
      if(eDel){fallos.push(`${lote.length} servicio(s) con sus paraderos de antes: no se pudieron borrar (${eDel.message}).`);continue;}

      const filas=lote.flatMap(rid=>(esRet.has(rid)?tramoRet:paradasIda).map((p,k)=>filaDe(rid,p,k)));
      // UNA sentencia por lote: o entran todas las filas del lote o ninguna (nunca medio itinerario).
      const{error:eIns}=filas.length?await supabase.from("paradas").insert(filas):{error:null};
      if(eIns){fallos.push(`${lote.length} servicio(s) quedaron SIN paraderos: se borraron y no se pudieron crear (${eIns.message}). Su semilla ya es la nueva: se vuelven a crear al abrirlos (y los de hoy que se ofrecen al pasajero, solos en unos minutos).`);continue;}

      const eOD=(await syncOD(loteIda,paradasIda))||(await syncOD(loteRet,tramoRet));
      if(eOD)fallos.push(`${lote.length} servicio(s) con paraderos nuevos pero sin actualizar origen/destino/hora (${eOD}).`);
      hechos+=lote.length;
    }

    setModalPropagar(null);setPropagando(false);
    const lineas=[...lineasFuera];
    if(conPasajerosTarde>0)lineas.push(`• ${conPasajerosTarde} sin tocar: alguien eligió su paradero mientras se propagaba`);
    fallos.forEach(f=>lineas.push(`⚠ ${f}`));
    alert(`${fallos.length?"⚠ Propagación con problemas":"✅ Propagación completada"}\n• ${hechos} servicio${hechos!==1?"s":""} actualizado${hechos!==1?"s":""}${lineas.length?`\n${lineas.join("\n")}`:""}`);
  };
  const eliminarCotizacion=async(pass:string):Promise<string|null>=>{
    if(!modalEliminar)return null;
    const{data:{session}}=await supabase.auth.getSession();
    if(!session?.user?.email)return "No hay sesión activa";
    const{error:authErr}=await supabase.auth.signInWithPassword({email:session.user.email,password:pass});
    if(authErr)return "Contraseña incorrecta";
    const{error}=await supabase.from("cotizaciones").delete().eq("id",modalEliminar.id);
    if(error)return "Error al eliminar: "+error.message;
    setModalEliminar(null);refrescar();return null;
  };
  const duplicarCotizacion=async(c:Cotizacion)=>{
    const payload:any={cliente_id:c.cliente_id,origen:c.origen,destino:c.destino,km:c.km,precio_cliente:c.precio_cliente,costo_estimado:c.costo_estimado,margen_estimado:c.margen_estimado,estado:"pendiente",numero_cotizacion:null,atencion:c.atencion,asunto:c.asunto?`COPIA — ${c.asunto}`:null,punto_retorno:c.punto_retorno,fecha_servicio:c.fecha_servicio,fecha_retorno:c.fecha_retorno,hora_ida:c.hora_ida,hora_retorno:c.hora_retorno,descuento_pct:c.descuento_pct||0,items_json:c.items_json,tipo_vehiculo:c.tipo_vehiculo,tipo_servicio:c.tipo_servicio,equipamiento:c.equipamiento,vehiculo_flota_id:c.vehiculo_flota_id,vehiculo_tercero_id:c.vehiculo_tercero_id,consideraciones_json:c.consideraciones_json,paradas_json:c.paradas_json,paradas_retorno_json:c.paradas_retorno_json,modo_servicio:c.modo_servicio,dias_servicio:c.dias_servicio||1,horas_servicio:c.horas_servicio||8,pernocte_costo:c.pernocte_costo,precio_dia:c.precio_dia,precio_mes_estimado:c.precio_mes_estimado,precio_tarifario:c.precio_tarifario,precio_cotizador:c.precio_cotizador,precio_sugerido:c.precio_sugerido,incluye_igv:c.incluye_igv!==false,itinerario_texto:c.itinerario_texto,fechas_multidia_json:c.fechas_multidia_json,plantilla_pdf:c.plantilla_pdf||"corporativo"};
    if(c.ruta_coords_json)payload.ruta_coords_json=c.ruta_coords_json;
    // Las condiciones y la plantilla se copian TAL CUAL (con su versión y su plantilla, o sin ellas):
    // la copia imprime lo mismo que la original.
    // La moneda, el tipo de cambio congelado y el idioma del PDF viajan con la copia (cotizaciones-04).
    if(c.moneda!=null)payload.moneda=normalizarMoneda(c.moneda);
    if(c.tipo_cambio!=null)payload.tipo_cambio=c.tipo_cambio;
    if(c.idioma_pdf!=null)payload.idioma_pdf=normalizarIdioma(c.idioma_pdf);
    // Quien duplica es el vendedor de la copia (comisiones-02). Si falta la columna, se guarda igual.
    const{data:{session:sesDup}}=await supabase.auth.getSession();
    payload.vendedor_id=sesDup?.user?.id??null;
    let{error}=await supabase.from("cotizaciones").insert(payload);
    if(error&&faltaColumna(error,"ruta_coords_json")){delete payload.ruta_coords_json;({error}=await supabase.from("cotizaciones").insert(payload));}
    if(error&&faltaColumna(error,"vendedor_id")){delete payload.vendedor_id;({error}=await supabase.from("cotizaciones").insert(payload));}
    let avisoCopia="";
    for(let g=0;g<3&&error;g++){
      const col=faltaAlguna(error,COLS_MONEDA);if(!col||!(col in payload))break;
      const eraUsd=payload.moneda==="USD";
      for(const k of COLS_MONEDA)delete payload[k];
      setFaltaMonedaGuardado(true);
      if(eraUsd)avisoCopia=`\n⚠️ La original está en dólares, pero la base no tiene la columna «${col}» (${SQL_MONEDA}): la copia quedó en SOLES y en español, con los mismos importes en soles.`;
      ({error}=await supabase.from("cotizaciones").insert(payload));
    }
    if(error){alert(error.message);return;}
    alert(`✅ Cotización #${c.numero_cotizacion||c.id} duplicada correctamente${avisoCopia}`);
    refrescar();
  };
  // «→ Res.»: lo hace el EJECUTOR compartido con el «✅ Hay unidad» del CRM (lib/cotizacion-a-reserva-datos.ts,
  // con el plan PURO de lib/cotizacion-a-reserva.ts): las mismas preguntas, las mismas escrituras en el
  // mismo orden y el mismo aviso que el código que vivía aquí (la matriz scripts/prueba-cotizacion-a-reserva.mts
  // corre el viejo copiado literal contra el ejecutor). La página solo pregunta, avisa y refresca.
  const convertirAReserva=async(cot:Cotizacion)=>{
    const r=await ejecutarConversion(supabase,cot as unknown as CotParaReserva,{hoy:hoyLima(),confirmar:(t)=>confirm(t)});
    // `aviso` va aparte del aviso de siempre: hoy, que se convirtió sin el candado (falta cotizaciones-07).
    const texto=[r.mensaje,r.aviso?`⚠️ ${r.aviso}`:""].filter(Boolean).join("\n\n");
    if(texto)alert(texto);
    if(r.refrescar)refrescar();
  };
  const editarCot=(c:Cotizacion)=>{
    // Se teclea en la moneda de la cotización: con dólares y un TC válido, ítems y precio/día se
    // enseñan en US$ (lo guardado sigue en soles). Sin TC válido, en soles.
    const mon=normalizarMoneda(c.moneda);const rtc=revisarTipoCambio(c.tipo_cambio);
    const enUsd=mon==="USD"&&rtc.tc!=null;
    if(enUsd)setUltimoTc(rtc.tc);
    setMonedaItems(enUsd?"USD":"PEN");baseSolesRef.current=null;
    const itemsBase:ItemCot[]=c.items_json?.length?c.items_json:[{descripcion:c.asunto||`${c.origen}→${c.destino}`,dias:1,cantidad:1,precio_unit:Math.round(Number(c.precio_cliente||0)/1.18*100)/100,descuento_pct:0}];
    const pdTxt=c.precio_dia?String(enUsd?aMonedaCot(Number(c.precio_dia),"USD",rtc.tc):c.precio_dia):"";
    restaurarRuta(c);setKmBase(null);setKmRet(null);setAvisoRet("");setCalculandoKm(false);setErrorKm("");skipDescRef.current=true;skipParadasRef.current=true;setForm({cliente_id:String(c.cliente_id||""),origen:c.origen||"",destino:c.destino||"",km:c.km?String(c.km):"",costo_estimado:c.costo_estimado?String(c.costo_estimado):"",estado:(c.estado||"pendiente") as EstadoCot,numero_cotizacion:c.numero_cotizacion||"",atencion:c.atencion||"",asunto:c.asunto||"",punto_retorno:c.punto_retorno||"",fecha_servicio:c.fecha_servicio||"",fecha_retorno:c.fecha_retorno||"",hora_ida:c.hora_ida||"",hora_retorno:c.hora_retorno||"",descuento_pct:c.descuento_pct?String(c.descuento_pct):"0",tipo_vehiculo:c.tipo_vehiculo||"",equipamiento:c.equipamiento||"full_equipo",vehiculo_flota_id:c.vehiculo_flota_id?String(c.vehiculo_flota_id):"",vehiculo_tercero_id:c.vehiculo_tercero_id?String(c.vehiculo_tercero_id):"",modo_servicio:(c.modo_servicio||"eventual") as ModoServ,tipo_servicio:c.tipo_servicio||"solo_ida",dias_servicio:String(c.dias_servicio||1),horas_servicio:String(c.horas_servicio||8),pernocte_costo:String(c.pernocte_costo||0),precio_dia:pdTxt,incluye_igv:c.incluye_igv!==false,itinerario_texto:c.itinerario_texto||"",moneda:mon,tipo_cambio:c.tipo_cambio!=null?String(c.tipo_cambio):"",idioma_pdf:normalizarIdioma(c.idioma_pdf)});setItems(enUsd?(itemsEnMoneda(itemsBase,"USD",rtc.tc)??itemsBase):itemsBase);/* lo que su PDF imprime hoy, con su plantilla: guardarla no le cambia el PDF */fijarConsidDeCotizacion(c);idiomaTocadoRef.current=true;setParadas(c.paradas_json||[]);setParadasRetorno(c.paradas_retorno_json||[]);setVehExpandido(!!c.tipo_vehiculo);skipFechasRef.current=true;setFechasMultidia((c.fechas_multidia_json||[]).map((d:any,idx:number,arr:any[])=>({dia:d.dia,fecha:d.fecha||"",hora_ida:d.hora_ida||"",hora_fin:d.hora_fin??d.hora_retorno??"",tipo_noche:d.tipo_noche!==undefined?d.tipo_noche:(idx===arr.length-1?"":"pernocte"),destino_nombre:d.destino_nombre||"",destino_lat:d.destino_lat||"",destino_lng:d.destino_lng||""})));setEditandoId(c.id);setMostrarForm(true);setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),50);};
  /**
   * Arma el PDF con lib/cotizacion-pdf.ts (`htmlCotizacion`): devuelve el HTML y lo que hay que
   * AVISAR antes de enviarlo. `html: null` solo con dólares sin tipo de cambio válido.
   * Un TRASLADO de la IA del CRM (`traslado_json`) con una plantilla de diseño corporativo imprime
   * LO MISMO que el PDF que se manda por WhatsApp (components/cotizaciones/pdf-traslado.ts), siempre
   * en castellano (`idioma` dice en qué idioma salió de verdad). Las demás cotizaciones, como siempre.
   * `plantilla` es el ID de la plantilla; el diseño que dibuja es `disenoDe(fila)`.
   */
  const prepararPDF=async(cot:Cotizacion,plantilla:string,idioma:Idioma):Promise<ResultadoPdf&{plantilla:string;idioma?:Idioma}>=>{
    const cl=cot.cliente_id!=null?mapaClientes.get(cot.cliente_id):undefined;
    const its=cot.items_json?.length?cot.items_json:[{descripcion:`${cot.asunto||"SERVICIO"} — ${cot.origen}→${cot.destino}`,dias:1,cantidad:1,precio_unit:cot.precio_cliente/1.18,descuento_pct:0}];
    // Recopilar todos los vehículos únicos: nivel cotización + por ítem
    const vehsMap=new Map<number,VehiculoFlota>();
    const addF=(id?:number|null)=>{if(!id)return;const v=flota.find(v=>v.id===id);if(v)vehsMap.set(v.id,v);};
    const addT=(id?:number|null)=>{if(!id)return;const vt=flotaTercero.find(v=>v.id===id);if(vt)vehsMap.set(-(vt.id),terceroAFlota(vt));};
    const itemsConVeh=its.some(it=>it.vehiculo_flota_id||it.vehiculo_tercero_id);
    if(!itemsConVeh){addF(cot.vehiculo_flota_id);addT(cot.vehiculo_tercero_id);}
    its.forEach(it=>{addF(it.vehiculo_flota_id);addT(it.vehiculo_tercero_id);});
    const vehiculos=[...vehsMap.values()];
    let nombreFinal=(cot as any).creado_por||"";
    if(!nombreFinal){try{nombreFinal=(await operadorActual()).nombre;}catch(e){}}
    // La fila de la plantilla se relee al imprimir (pudo editarse en Plantillas PDF); si la lectura
    // falla, la de la lista ya cargada.
    const[{data:empData},rPl]=await Promise.all([supabase.from("empresa_perfil").select("*").eq("id",1).maybeSingle(),Promise.resolve(supabase.from("cotizacion_plantillas").select("*").eq("id",plantilla).maybeSingle()).catch(()=>({data:null,error:{message:"sin conexión"}}))]);
    const fila:PlantillaFila|null=rPl.error?plantillaPorId(plantillas,plantilla):(rPl.data as PlantillaFila|null);
    const diseno=disenoDe(fila??{id:plantilla});
    const elegida={id:plantilla,nombre:fila?.nombre||plantilla};
    if(diseno==="corporativo"&&esTrasladoIA(cot)){
      // Como el servidor (plantillaYReferenciaCuentas): una plantilla DESACTIVADA no presta sus cuentas: las de `corporativo`.
      const plCuentas=fila&&!esActiva(fila)?plantillaPorId(plantillas,"corporativo"):fila;
      const e=await entradaTrasladoPagina(cot as unknown as FilaCotizacionLeida,{empresa:empData as EmpresaPerfilPDF|null,plantilla:plCuentas,cliente:clienteErpDe(cl),baseCondiciones:window.location.origin}).catch(()=>null);
      if(e){
        const{clienteNoVerificado,...entrada}=e;
        const rt=htmlCotizacion(entrada);
        // El traslado imprime las condiciones de SU fila: si se copiaron de otra plantilla, se dice.
        const otra=avisoCondicionesDeOtraPlantilla(cot.consideraciones_json,elegida,nombrePlantilla);
        const avisos=[...rt.avisos,...(idioma==="es"?[]:[{codigo:"textos_escritos_tal_cual" as const,bloquea:false,detalle:AVISO_TRASLADO_EN_CASTELLANO}]),...(clienteNoVerificado?[{codigo:"cliente_no_verificado" as const,bloquea:false,detalle:AVISO_CLIENTE_NO_VERIFICADO}]:[]),...(otra?[otra]:[])];
        return{...rt,avisos,plantilla,idioma:"es"};
      }
    }
    // La que se está editando imprime lo que muestra el formulario, como quedará guardada (versión 2).
    // Una sin condiciones guardadas, las de fábrica (lo mismo que carga el formulario al abrirla).
    const considFinal:ConsidFila=editandoId===cot.id?{incluye:consid.incluye,no_incluye:consid.no_incluye,generales:consid.generales,...(Array.isArray(consid.reserva)?{reserva:consid.reserva}:{}),...(Array.isArray(consid.reserva)&&Array.isArray(consid.reserva_resumen)?{reserva_resumen:consid.reserva_resumen}:{}),version:CONSID_VERSION,plantilla:plantillaForm}:(cot.consideraciones_json||{...DEFAULT_CONSID});
    const r=htmlCotizacion({
      cot,cliente:cl,items:its,vehiculos,repr:nombreFinal,consid:considFinal,plantilla:diseno,
      cfg:fila,empresa:empData as EmpresaPerfilPDF|null,
      idioma,tipoVehiculoNombre:paramsDB.find(p=>p.tipo_vehiculo===cot.tipo_vehiculo)?.nombre??null,
      // El enlace (y el QR) a la política completa de ESTA cotización: con él y un resumen, el PDF imprime el resumen.
      enlaceCondiciones:enlaceCondiciones(window.location.origin,cot.condiciones_token),
    });
    const otra=avisoCondicionesDeOtraPlantilla(considFinal,elegida,nombrePlantilla);
    return{...r,avisos:otra?[...r.avisos,otra]:r.avisos,plantilla};
  };
  const abrirPDF=async(cot:Cotizacion,plantilla:string=plantillaElegida,idioma:Idioma=idiomaPdfModal)=>{
    if(generandoPdf)return;
    setGenerandoPdf(true);
    try{
      const r=await prepararPDF(cot,plantilla,idioma);
      setAvisosPdf(r.avisos);
      // Sin HTML no se abre ventana: el modal sigue abierto con el motivo (dólares sin tipo de cambio).
      if(!r.html){alert(r.avisos.map(a=>a.detalle).join("\n")||"No se pudo generar el PDF.");return;}
      const win=window.open("","_blank");
      if(!win){alert("El navegador bloqueó la ventana emergente. Permite las ventanas emergentes para este sitio y vuelve a intentarlo.");return;}
      win.document.write(r.html);win.document.close();
      // La plantilla y el idioma elegidos quedan en la cotización (best-effort: idioma_pdf es de cotizaciones-04).
      const cambios:Record<string,string>={};
      // Siempre que cambie, también a la corporativa: es la que se preselecciona la próxima vez.
      if(plantilla!==cot.plantilla_pdf)cambios.plantilla_pdf=plantilla;
      const idiomaImpreso=r.idioma??idioma;
      if(idiomaImpreso!==normalizarIdioma(cot.idioma_pdf))cambios.idioma_pdf=idiomaImpreso;
      if(Object.keys(cambios).length){
        let{error}=await supabase.from("cotizaciones").update(cambios).eq("id",cot.id);
        if(error&&faltaColumna(error,"idioma_pdf")&&cambios.idioma_pdf){delete cambios.idioma_pdf;setFaltaMonedaGuardado(true);if(Object.keys(cambios).length)({error}=await supabase.from("cotizaciones").update(cambios).eq("id",cot.id));}
        cacheDetalle.current.delete(cot.id);
        // Si es la que está abierta en el formulario, su plantilla pasa a ser esta (si no, guardarla la devolvería a la anterior).
        if(cambios.plantilla_pdf&&!error&&editandoId===cot.id)setPlantillaFijada({id:plantilla,origen:"manual"});
      }
      setModalPlantilla(null);
    }catch(e){alert(`No se pudo generar el PDF: ${(e as {message?:string})?.message||String(e)}`);}
    finally{setGenerandoPdf(false);}
  };
  const abrirModalPlantilla=(d:Cotizacion)=>{setModalPlantilla(d);setPlantillaElegida(d.plantilla_pdf||"corporativo");setIdiomaPdfModal(normalizarIdioma(d.idioma_pdf));setAvisosPdf(null);setErrorAvisosPdf("");};

  // Un vehículo de tercero visto como uno de flota, para los documentos. El texto de
  // respaldo importa: sin él, buildVehsHtml inventa la descripción genérica de la flota
  // propia ("con A/C, audio, asientos reclinables") para una unidad que no conocemos.
  // REGLA DURA: estos documentos (cotización, Ficha Técnica de Ruta) van al CLIENTE, y el
  // cliente NUNCA debe saber que la unidad es tercerizada. Ni el nombre de la empresa
  // proveedora ni la palabra "tercero" salen al papel; la unidad se identifica por su placa.
  // Una descripción escrita a mano que nombre a la empresa se descarta por lo mismo.
  const terceroAFlota=(t:VehiculoTerceroFlota):VehiculoFlota=>({
    id:t.id,placa:t.placa,categoria:t.categoria,marca:t.marca,modelo:t.modelo,anio:null,
    capacidad_pasajeros:t.capacidad,equipamiento:null,
    foto_externa_url:t.foto_externa_url,foto_interna_url:t.foto_interna_url,
    descripcion_unidad:descripcionTerceroParaCliente(t),
    tipo_vehiculo_costeo:t.tipo_vehiculo_costeo,
  });

  // Los avisos del modal se calculan para la plantilla y el idioma elegidos, ANTES de generar.
  useEffect(()=>{
    if(!modalPlantilla)return;
    let vigente=true;
    prepararPDF(modalPlantilla,plantillaElegida,idiomaPdfModal)
      .then(r=>{if(vigente)setAvisosPdf(r.avisos);})
      .catch(e=>{if(vigente)setErrorAvisosPdf((e as {message?:string})?.message||String(e));});
    return()=>{vigente=false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[modalPlantilla,plantillaElegida,idiomaPdfModal]);

  // Vehículos asignados a la cotización (mismo criterio que el PDF: nivel cotización + por ítem).
  const vehiculosDeCot=(cot:Cotizacion):VehiculoFlota[]=>{
    const m=new Map<number,VehiculoFlota>();
    const addF=(id?:number|null)=>{if(!id)return;const v=flota.find(v=>v.id===id);if(v)m.set(v.id,v);};
    const addT=(id?:number|null)=>{if(!id)return;const t=flotaTercero.find(v=>v.id===id);if(t)m.set(-t.id,terceroAFlota(t));};
    const its=cot.items_json||[];
    if(!its.some(it=>it.vehiculo_flota_id||it.vehiculo_tercero_id)){addF(cot.vehiculo_flota_id);addT(cot.vehiculo_tercero_id);}
    its.forEach(it=>{addF(it.vehiculo_flota_id);addT(it.vehiculo_tercero_id);});
    return[...m.values()];
  };

  // Pide la geometría y los km/min de un sentido. Sin tráfico: es el SKU barato y además
  // el server ya cachea esas respuestas, así que repetir la misma ruta no le pega a Google.
  const metricaDeSentido=async(puntos:PuntoFicha[]):Promise<MetricaSentido|null>=>{
    const con=puntosConCoords(puntos);
    if(con.length<2)return null;
    const r=await fetch("/api/ruta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({paradas:con.map(p=>({nombre:p.nombre,lat:p.lat,lng:p.lng})),conTrafico:false})});
    if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||`Ruta HTTP ${r.status}`);
    const d=await r.json();
    // La polilínea se guarda diezmada: entra en la URL del mapa y pesa poco en la BD.
    return{poly:encodePolyline(diezmar((d.coordenadas||[]) as [number,number][],160)),tramos:(d.tramos||[]).map((t:any)=>({distancia_km:Number(t.distancia_km)||0,duracion_min:Number(t.duracion_min)||0})),total_km:Number(d.total_km)||0,total_min:Number(d.total_min)||0};
  };

  const abrirFicha=async(cot:Cotizacion)=>{
    if(fichaCargando)return;
    setFichaCargando(cot.id);
    try{
      // 1. Puntos. Si la cotización no tiene paraderos cargados, se arma con origen/destino
      //    para que el botón nunca emita un documento vacío (eso sí, sin mapa ni km).
      const pIda=cot.paradas_json?.length?construirPuntos(cot.paradas_json,"I"):puntosDesdeTexto(cot.origen,cot.destino,"I",cot.hora_ida||"","");
      const pRet=cot.paradas_retorno_json?.length?construirPuntos(cot.paradas_retorno_json,"R")
        :(cot.punto_retorno?puntosDesdeTexto(cot.destino,cot.punto_retorno,"R",cot.hora_retorno||"",""):[]);

      // 2. Métricas: se reusan mientras las coordenadas no cambien.
      const firma=firmaRutaFicha(pIda,pRet);
      let metrica=cot.ficha_ruta_json&&cot.ficha_ruta_json.firma===firma?cot.ficha_ruta_json:null;
      let aviso="";
      if(!metrica){
        if(puntosConCoords(pIda).length<2&&puntosConCoords(pRet).length<2){
          aviso="Los paraderos de esta cotización no tienen coordenadas cargadas: la ficha se emite sin mapa ni distancias.";
        }else{
          // allSettled y no all: si Google falla en un sentido (ZERO_RESULTS, corte de red,
          // tope de consultas), el otro ya está pagado y sirve — con all se tiraban los dos.
          const[rIda,rRet]=await Promise.allSettled([metricaDeSentido(pIda),metricaDeSentido(pRet)]);
          const falló=(r:PromiseSettledResult<MetricaSentido|null>)=>r.status==="rejected";
          metrica={firma,calculado_at:new Date().toISOString(),
            ida:rIda.status==="fulfilled"?rIda.value:null,
            retorno:rRet.status==="fulfilled"?rRet.value:null};
          if(falló(rIda)||falló(rRet)){
            const motivo=[falló(rIda)?"entrada":"",falló(rRet)?"retorno":""].filter(Boolean).join(" y ");
            const err=(falló(rIda)?(rIda as PromiseRejectedResult).reason:(rRet as PromiseRejectedResult).reason);
            aviso=`No se pudieron calcular distancias y tiempos del tramo de ${motivo} (${err?.message||"error de ruta"}). Ese tramo se emite con las horas programadas.`;
          }else{
            // Solo se cachea el cálculo completo: guardar un sentido caído lo congelaría.
            await supabase.from("cotizaciones").update({ficha_ruta_json:metrica}).eq("id",cot.id);
            cacheDetalle.current.delete(cot.id); // el detalle en memoria ya no es el de la base
          }
        }
      }

      // 3. Mapa, QR y datos de la unidad.
      const tk=process.env.NEXT_PUBLIC_MAPBOX_TOKEN||"";
      const mapaIda=urlMapaEstatico(pIda,metrica?.ida?.poly||"","#0b315f",tk);
      const mapaRet=urlMapaEstatico(pRet,metrica?.retorno?.poly||"","#6d28d9",tk);
      // Un QR por sentido: el retorno no es el inverso de la ida, tiene sus propios puntos.
      // La URL además va como hipervínculo, para abrir la ruta desde el PDF con un clic.
      const urlIda=urlGoogleMapsRuta(pIda),urlRet=urlGoogleMapsRuta(pRet);
      let qrIda="",qrRet="";
      try{
        const{default:QRCode}=await import("qrcode");
        if(urlIda)qrIda=await QRCode.toDataURL(urlIda,{margin:1,width:240});
        if(urlRet)qrRet=await QRCode.toDataURL(urlRet,{margin:1,width:240});
      }catch{}

      const{data:empData}=await supabase.from("empresa_perfil").select("*").eq("id",1).maybeSingle();

      const emp=empData as EmpresaPerfilPDF|null;
      const cl=cot.cliente_id!=null?mapaClientes.get(cot.cliente_id):undefined;
      const nomCl=cl?.tipo==="b2b"?(cl.empresa||cl.nombre):cl?.nombre||"—";
      const vehs=vehiculosDeCot(cot);
      const servLabel=[...SERVS_EVENTUAL,...SERVS_FIJO].find(s=>s.id===cot.tipo_servicio)?.label.replace(/^\S+\s/,"")||"Servicio de transporte";
      const fechaLarga=(f:string|null)=>f?new Date(f+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"long",year:"numeric"}).toUpperCase():"—";
      generarFichaRuta({
        nCot:cot.numero_cotizacion||String(cot.id).padStart(5,"0"),
        anio:cot.created_at?new Date(cot.created_at).getFullYear():new Date().getFullYear(),
        emitida:new Date().toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}),
        cliente:{nombre:nomCl,docLabel:cl?.ruc?"RUC":"DOC",doc:cl?.ruc||cl?.dni||"—",contacto:cot.atencion||cl?.operativo_nombre||"—",telefono:cl?.telefono||"—"},
        servicio:{
          ruta:cot.asunto||`${cot.origen||"—"} → ${cot.destino||"—"}`,
          modalidad:`${cot.modo_servicio==="fijo"?"Servicio fijo (recurrente)":"Servicio eventual"} · ${servLabel}`,
          inicio:fechaLarga(cot.fecha_servicio),
          retornoLabel:cot.fecha_retorno?"RETORNO":"VIGENCIA",
          retorno:cot.fecha_retorno?fechaLarga(cot.fecha_retorno):"Según programación acordada",
        },
        horaIda:cot.hora_ida||"",horaRetorno:cot.hora_retorno||"",
        puntosIda:pIda,puntosRet:pRet,metrica,mapaIda,mapaRet,qrIda,qrRet,urlIda,urlRet,
        vehiculos:vehs,
        unidadDetalle:vehs.map(v=>[v.placa,v.marca,v.modelo,v.capacidad_pasajeros?`${v.capacidad_pasajeros} pax`:""].filter(Boolean).join(" · ")).join("   |   "),
        empresa:{nombre:EMP(emp).nombre,email:EMP(emp).email,telefono:EMP(emp).telefono,web:EMP(emp).web,direccion:EMP(emp).direccion,logo:emp?.logo_url||LOGO_DEFAULT},
        aviso,
      });
    }catch(e:any){
      alert(`No se pudo generar la ficha: ${e?.message||e}`);
    }finally{
      setFichaCargando(null);
    }
  };

  const totC=cotizas.length;const pendDesc=kpis.descPend;
  const listaVigente=listaDe===claveLista;
  const errorVigente=errorLista&&errorLista.clave===claveLista?errorLista.motivo:null;
  const fmtISO=(f:string)=>f.split("-").reverse().join("/");
  const rotuloPeriodo=periodo==="rango"&&rangoLista.codigo==="ok"?`Del ${fmtISO(rangoManual.desde)} al ${fmtISO(rangoManual.hasta)}`:periodo==="todo"?"Todas las fechas":ETIQUETA_PERIODO[periodo];
  const motivoRango=rangoLista.codigo==="rango_incompleto"?"Elige las dos fechas del rango (desde y hasta) para ver las cotizaciones.":rangoLista.codigo==="rango_invertido"?"La fecha «desde» es posterior a «hasta»: corrige el rango.":null;
  const visibles=filtradas.slice(0,nVisibles);
  const hayFiltros=periodo!==PERIODO_DEFECTO||eje!==EJE_DEFECTO||filtroEst!=="todos"||filtroModo!=="todos"||!!busqueda.trim()||!!rangoManual.desde||!!rangoManual.hasta;
  const limpiarFiltros=()=>{setPeriodo(PERIODO_DEFECTO);setEje(EJE_DEFECTO);setRangoManual({desde:"",hasta:""});setFiltroEst("todos");setFiltroModo("todos");setBusqueda("");setBusquedaDeb("");};
  const nomCl=(id:number|null)=>{const c=id!=null?mapaClientes.get(id):undefined;if(!c)return "Sin cliente";return rotuloCliente(c);};
  const kmNum=Number(form.km)||0;const vehFloraSel=flota.find(v=>v.id===Number(form.vehiculo_flota_id));const vehTerceroSel=flotaTercero.find(v=>v.id===Number(form.vehiculo_tercero_id));const tarifaNombreSel=paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo)?.nombre||form.tipo_vehiculo;const servsList=form.modo_servicio==="eventual"?SERVS_EVENTUAL:SERVS_FIJO;const esFijoForm=form.modo_servicio==="fijo";
  const esSoloIda=["solo_ida","fijo_solo_ida"].includes(form.tipo_servicio);
  const requiereParadas=["ida_retorno_paradas","fijo_multiparada"].includes(form.tipo_servicio);
  /** El recorrido de vuelta se define en los fijos con hora de retorno y en todo eventual que vuelve
   *  (el multi-día lleva su cronograma). Antes solo existía en los fijos. */
  const retornoConRecorrido=!esSoloIda&&form.tipo_servicio!=="multi_dia"&&(form.modo_servicio!=="fijo"||!!form.hora_retorno);
  /** Dónde termina la vuelta: el punto de retorno si se escribió (con sus coordenadas solo si se eligió),
   *  si no, el origen — la misma regla que mide el km. */
  const finRetorno=form.punto_retorno.trim()?{nombre:form.punto_retorno.trim(),place:retornoPlace&&coordValida(retornoPlace.lat,retornoPlace.lng)?retornoPlace:null}:{nombre:form.origen,place:origenPlace&&coordValida(origenPlace.lat,origenPlace.lng)?origenPlace:null};
  const esTurismo=["full_day","multi_dia"].includes(form.tipo_servicio);

  return(
    <>
      {modalEnvio&&<ModalEnvio onConfirmar={confirmarEnvio} onCancelar={()=>setModalEnvio(null)} ocupado={estadoEnCurso!==null}/>}
      {modalDespacho&&<ModalDespachoSinCotizar nombreCliente={(id)=>{const cl=id!=null?clientes.find(c=>c.id===id):null;return cl?rotuloCliente(cl as any):(id!=null?`Cliente #${id}`:"Sin cliente");}} onCerrar={()=>setModalDespacho(false)} onCambio={contarDespacho} onCotizar={cotizarDespacho}/>}
      {modalAprob&&<ModalAprobacion cot={modalAprob} onConfirmar={confirmarAprob} onCancelar={()=>setModalAprob(null)} ocupado={estadoEnCurso!==null}/>}
      {modalPlantilla&&<ModalPlantilla cot={modalPlantilla} plantillas={plantillas} errorPlantillas={lecturaPl.error} plantillaActual={plantillaElegida} onElegir={id=>{setPlantillaElegida(id);setAvisosPdf(null);setErrorAvisosPdf("");}} idioma={idiomaPdfModal} onIdioma={i=>{setIdiomaPdfModal(i);setAvisosPdf(null);setErrorAvisosPdf("");}} avisos={avisosPdf} errorAvisos={errorAvisosPdf} generando={generandoPdf} onGenerar={()=>abrirPDF(modalPlantilla,plantillaElegida,idiomaPdfModal)} onCancelar={()=>setModalPlantilla(null)}/>}
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
              <p>• Los servicios con <strong>pasajeros asignados</strong> tampoco: cámbialos desde su Manifiesto.</p>
              {modalPropagar.paradasRet.length===0&&modalPropagar.reservas.some(r=>r.direccion_servicio==="retorno")&&(
                <p>• Esta cotización no tiene <strong>paraderos de retorno</strong>: sus retornos no se tocan (no se deducen de la ida).</p>
              )}
              <p>• Esta acción reemplaza las paradas de cada servicio futuro.</p>
              <p>• La <strong>hora de salida</strong> de cada servicio se ajusta a la del primer paradero de su tramo.</p>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={()=>setModalPropagar(null)} disabled={propagando} title={propagando?"Espera a que termine la propagación":undefined} className="flex-1 py-2.5 px-4 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">Solo esta cotización</button>
              <button onClick={confirmarPropagar} disabled={propagando} className="flex-1 py-2.5 px-4 rounded-xl text-sm font-bold text-white disabled:opacity-60" style={{background:"#0b315f"}}>{propagando?"Actualizando...":"Propagar a futuros ("+modalPropagar.reservas.length+")"}</button>
            </div>
          </div>
        </div>
      )}
      <main className="p-3 md:p-6 space-y-4 md:space-y-5 max-w-7xl mx-auto">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div><h1 className="text-xl md:text-3xl font-bold text-gray-900">Cotizaciones</h1><p className="text-sm text-gray-400 mt-1">EVENTUAL · FIJO · {paramsDB.length} vehículos desde Supabase{listaVigente&&pendDesc>0&&<span className="ml-2 text-orange-600 font-bold bg-orange-50 px-2 py-0.5 rounded-full text-xs">🙋 {pendDesc} descuento{pendDesc>1?"s":""} pendiente{pendDesc>1?"s":""}</span>}{(errDespacho||(pendDespacho??0)>0)&&<button type="button" onClick={()=>setModalDespacho(true)} title={errDespacho?`No se pudo contar: ${errDespacho}`:"Regularizar los servicios del Despachador sin cotización"} className="ml-2 text-purple-700 font-bold bg-purple-50 hover:bg-purple-100 px-2 py-0.5 rounded-full text-xs border border-purple-200">⚡ {errDespacho?"?":pendDespacho} sin cotizar (Despachador)</button>}</p></div>
          <div className="flex gap-2 flex-wrap"><a href="/cotizador" className="px-4 py-2.5 rounded-xl font-bold text-sm border text-[#0b315f] border-[#0b315f] hover:bg-[#eef3f8]">🔧 Cotizador</a><button onClick={()=>{mostrarForm?limpiar():setMostrarForm(true);}} className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{background:mostrarForm?"#6b7280":"#0b315f"}}>{mostrarForm?"✕ Cancelar":"+ Nueva cotización"}</button></div>
        </div>

        <div className="space-y-1.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{rotuloPeriodo} · por {eje==="emision"?"emisión":"fecha del servicio"}{filtroModo!=="todos"&&<span> · solo {filtroModo==="fijo"?"fijos":"eventuales"}</span>}</p>
        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          {[{label:"Total",val:kpis.total,color:"#0b315f",bg:"#eef3f8"},{label:"Eventuales",val:kpis.eventuales,color:"#0b315f",bg:"#eef3f8"},{label:"Fijos",val:kpis.fijos,color:"#166534",bg:"#dcfce7"},{label:"Pendientes",val:kpis.pendientes,color:"#854d0e",bg:"#fef9c3"},{label:"Enviadas",val:kpis.enviadas,color:"#0369a1",bg:"#e0f2fe"},{label:"Aprobadas",val:kpis.aprobadas,color:"#166534",bg:"#dcfce7"},{label:"Tasa",val:`${kpis.tasa}%`,color:"#1d4ed8",bg:"#dbeafe"},{label:"Dscto. pend.",val:kpis.descPend,color:"#d97706",bg:"#fef3c7"}].map(k=>(
            <div key={k.label} className="rounded-xl p-3 border" style={{background:k.bg,borderColor:k.color+"22"}}><p className="text-[10px] font-bold uppercase tracking-wide" style={{color:k.color+"99"}}>{k.label}</p><p className="text-xl font-black mt-0.5" style={{color:k.color}}>{listaVigente?k.val:motivoRango?"—":"…"}</p></div>
          ))}
        </section>
        </div>

        {mostrarForm&&(
          <section className="bg-white rounded-2xl border shadow-sm p-4 md:p-6 space-y-5">
            {despachoOrigen&&(<div className="rounded-xl border border-purple-200 bg-purple-50 px-4 py-2.5 flex items-center justify-between gap-3"><span className="text-xs font-bold text-purple-800">⚡ Cotizando el servicio del Despachador #{despachoOrigen.codigo||despachoOrigen.id} del {String(despachoOrigen.fecha_servicio||"").split("-").reverse().slice(0,2).join("/")||"—"} — al guardar quedará vinculado</span><button onClick={()=>fijarDespachoOrigen(null)} className="text-xs font-bold text-purple-500 hover:text-purple-800 underline flex-shrink-0">Quitar el vínculo</button></div>)}
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
                <Campo label="Cliente" req extra={!cargandoClientes&&!errorClientes&&<span className="ml-1.5 normal-case tracking-normal font-semibold text-gray-300">· {clientes.filter(c=>!esBloqueado(c)).length} clientes</span>}>
                  <div className="flex gap-2"><SelectorCliente clientes={clientes} valor={form.cliente_id} onElegir={aplicarCliente} uso={usoCl} recientes={recientesCl} onCrear={abrirAltaCliente} cargando={cargandoClientes}/><button type="button" onClick={()=>abrirAltaCliente("")} title="Crear cliente (se abre en otra pestaña)" aria-label="Crear cliente" className="flex-shrink-0 w-10 h-10 rounded-xl border-2 flex items-center justify-center font-black text-lg" style={{background:"#eef3f8",borderColor:"#0b315f33",color:"#0b315f"}}>+</button></div>
                  {(()=>{if(!form.cliente_id)return null;const cl=clientes.find(c=>c.id===Number(form.cliente_id));
                    if(cl&&esBloqueado(cl))return<p className="text-[11px] font-semibold text-red-600 mt-1">Cliente bloqueado: no se puede guardar así</p>;
                    if(!cl&&errorClientes)return<p className="text-[11px] font-semibold text-amber-700 mt-1">No se pudo cargar la lista de clientes: no se puede comprobar el cliente #{form.cliente_id}. Recarga la página.</p>;
                    if(!cl&&!cargandoClientes)return<p className="text-[11px] font-semibold text-red-600 mt-1">Cliente #{form.cliente_id} no encontrado</p>;
                    return null;})()}
                </Campo>
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
                <Campo label="Idioma del PDF">
                  <select className={iCls()} value={form.idioma_pdf} onChange={e=>{idiomaTocadoRef.current=true;cambiarIdiomaPdf(normalizarIdioma(e.target.value));}}>
                    <option value="es">🇵🇪 Español</option><option value="en" disabled={faltaColMoneda&&form.idioma_pdf!=="en"}>🇺🇸 English</option>
                  </select>
                  {faltaColMoneda&&<p className="text-[10px] text-amber-700 mt-0.5">Sin {SQL_MONEDA} el idioma no se guarda (se elige al generar el PDF).</p>}
                </Campo>
                <Campo label="Moneda" span={2}>
                  <div className="flex items-center gap-3 pt-1 flex-wrap">
                    {(["PEN","USD"] as Moneda[]).map(m=>{const sel=form.moneda===m;const off=m==="USD"&&faltaColMoneda&&!sel;return(
                      <button key={m} type="button" disabled={off} onClick={()=>cambiarMoneda(m)} title={off?`Falta correr ${SQL_MONEDA}`:undefined} className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed" style={{background:sel?"#eef3f8":"white",borderColor:sel?"#0b315f":"#e5e7eb",color:sel?"#0b315f":"#9ca3af"}}>
                        {m==="PEN"?"S/ Soles":"US$ Dólares"}
                      </button>);})}
                    {form.moneda==="USD"&&<div className="flex items-center gap-2">
                      <label className="text-[10px] font-bold uppercase text-gray-400 whitespace-nowrap">Tipo de cambio (S/ por US$)</label>
                      <input inputMode="decimal" className={iCls("font-mono w-28")} placeholder="0.0000" value={form.tipo_cambio} onChange={e=>cambiarTipoCambio(e.target.value)}/>
                    </div>}
                  </div>
                  {faltaColMoneda&&form.moneda!=="USD"&&<p className="text-[10px] text-amber-700 font-semibold mt-1">Dólares no disponible: falta correr {SQL_MONEDA}. Mientras tanto se cotiza en soles.</p>}
                  {form.moneda==="USD"&&<div className="mt-1 space-y-0.5">
                    {/* La sugerencia se ENSEÑA con su fuente; el número lo escribe una persona (sin «usar este»). */}
                    <p className="text-[10px] text-gray-500">{sugTc==null?"Buscando un tipo de cambio de referencia…":sugTc.tc!=null?<>Referencia: <b className="font-mono">{sugTc.tc}</b> · {ETQ_FUENTE_TC[sugTc.fuente]} — {sugTc.detalle}</>:sugTc.detalle}</p>
                    {revTc.codigo!=="ok"?<p className="text-[10px] font-semibold text-red-600">{revTc.detalle} No se puede guardar hasta escribirlo.</p>
                      :<p className="text-[10px] text-gray-500">Los importes se teclean en dólares y se guardan en SOLES a este tipo de cambio (queda congelado en la cotización).</p>}
                    {detalleMoneda&&monedaItems!=="USD"&&<p className="text-[10px] text-amber-700 font-semibold">{detalleMoneda}</p>}
                  </div>}
                </Campo>
                <Campo label="Atención" span={2}><input className={iCls()} placeholder="Nombre del responsable" value={form.atencion} onChange={f("atencion")}/>
                  {contactosCl.length>0&&<div className="flex flex-wrap gap-1.5 mt-1.5">{contactosCl.map((c,i)=>{const nom=[c.nombre,c.apellido].map(x=>String(x??"").trim()).filter(Boolean).join(" ");const puesto=form.atencion.trim()===nom;return<button key={i} type="button" onClick={()=>setForm(p=>({...p,atencion:nom}))} title={[c.cargo,c.telefono,c.email].filter(Boolean).join(" · ")||undefined} className="text-[11px] rounded-lg border px-2 py-1 min-h-[32px] text-left transition-colors" style={{background:puesto?"#eef3f8":"white",borderColor:puesto?"#0b315f":"#e5e7eb",color:"#0b315f"}}>{c.principal?"★ ":""}<span className="font-semibold">{nom}</span>{c.cargo&&<span className="text-gray-400"> · {c.cargo}</span>}</button>;})}</div>}
                </Campo>
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
            {/* NIVEL DE SERVICIO · una sola palabra para lo que antes se decidía dos veces.
                Se llamaba «Tipo de movilidad · Full Equipo / Básico» y abajo, en «Vehículo de
                tarifa», seguían saliendo las fichas `· Estándar (>10 años)`: dos nombres para la
                misma decisión comercial, y ninguno acotaba al otro. Lo que se guarda sigue siendo
                `equipamiento` — ver lib/costos/nivel-servicio.ts. */}
            <div className="rounded-2xl border-2 p-4" style={{borderColor:"#e9d5ff",background:"#faf5ff"}}>
              <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{color:"#7c3aed"}}>Nivel de servicio</p>
              <div className="flex gap-2">
                {NIVELES.map(n=>{
                  const cfg=NIVEL_CFG[n];const act=nivel===n;
                  return(
                    <button key={n} onClick={()=>cambiarNivel(n)} className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 transition-all" style={{background:act?cfg.bg:"white",borderColor:act?cfg.color:"#e5e7eb",color:act?cfg.color:"#9ca3af"}}>
                      <div><p className="font-bold text-xs">{cfg.icono} {cfg.label}</p><p className="text-[10px] opacity-70">{cfg.sub}</p></div>
                    </button>
                  );
                })}
              </div>
              {avisoNivel&&<p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">⚠ {avisoNivel}</p>}
              {cotejoUnidad.codigo==="discrepa"&&<p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">⚠ {cotejoUnidad.detalle}</p>}
            </div>

            {/* ── VEHÍCULOS ── */}
            <div className="rounded-2xl border-2 overflow-hidden" style={{borderColor:"#e5e7eb"}}>
              <button className="w-full flex items-center justify-between px-4 py-3 transition-colors hover:bg-gray-50" style={{background:"#f9fafb"}} onClick={()=>setVehExpandido(v=>!v)}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-black text-gray-700">🚌 Vehículo de tarifa</span>
                  <span className="text-[10px] text-gray-400 font-normal">({fichasNivel.length} de nivel {NIVEL_CFG[nivel].label})</span>
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
                          <button key={v.tipo_vehiculo} onClick={()=>{elegirFicha(v.tipo_vehiculo);setVehExpandido(false);}} className="flex flex-col items-center px-1 py-2 rounded-xl border-2 transition-all text-center" style={{background:act?gc.bg:"white",borderColor:act?gc.color:"#e5e7eb",color:act?gc.color:"#9ca3af"}}>
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
                  <SelectorVehiculo tipo="propio" vehiculos={flota} valor={form.vehiculo_flota_id} onElegir={selVeh} uso={usoVehP} recientes={recVehP} tarifaTipo={form.tipo_vehiculo} tarifaNombre={tarifaNombreSel} cargando={loading}/>
                </Campo>
                <Campo label={`Vehículo tercerizado (${flotaTercero.length} activos)`}>
                  <SelectorVehiculo tipo="tercero" vehiculos={flotaTercero} valor={form.vehiculo_tercero_id} onElegir={selVehTercero} uso={usoVehT} recientes={recVehT} tarifaTipo={form.tipo_vehiculo} tarifaNombre={tarifaNombreSel} cargando={loading}/>
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
                    onChange={v=>{setForm(p=>({...p,origen:v,km:""}));setOrigenPlace(null);olvidarRenombreRuta("origen");setKmCongelado(null);setKmBase(null);setErrorKm("");}}
                    onSelect={p=>{setKmCongelado(null);olvidarRenombreRuta("origen");setOrigenPlace(coordValida(p.lat,p.lng)?{placeId:p.placeId||"",lat:p.lat,lng:p.lng,fuente:p.placeId?"lista":"coordenadas"}:null);if(p.address)setForm(prev=>({...prev,origen:p.address}));}}/>
                  <CoordsDePunto place={origenPlace} texto={form.origen} buscando={porGeocodificar.includes("origen")} fallo={geoFallo.includes("origen")}/>
                  <AvisoRenombreMapa estado={renombreRuta.origen} onVolver={()=>volverNombreRuta("origen")} onReintentar={()=>reintentarNombreRuta("origen")}/>
                </Campo>
                <Campo label="Punto de destino" req>
                  <LocationInputCot placeholder="Planta Cajamarquilla" value={form.destino} mapsLoaded={mapsLoaded}
                    onChange={v=>{setForm(p=>({...p,destino:v,km:""}));setDestinoPlace(null);olvidarRenombreRuta("destino");setKmCongelado(null);setKmBase(null);setErrorKm("");}}
                    onSelect={p=>{setKmCongelado(null);olvidarRenombreRuta("destino");setDestinoPlace(coordValida(p.lat,p.lng)?{placeId:p.placeId||"",lat:p.lat,lng:p.lng,fuente:p.placeId?"lista":"coordenadas"}:null);if(p.address)setForm(prev=>({...prev,destino:p.address}));}}/>
                  <CoordsDePunto place={destinoPlace} texto={form.destino} buscando={porGeocodificar.includes("destino")} fallo={geoFallo.includes("destino")}/>
                  <AvisoRenombreMapa estado={renombreRuta.destino} onVolver={()=>volverNombreRuta("destino")} onReintentar={()=>reintentarNombreRuta("destino")}/>
                </Campo>
                {!esSoloIda&&<Campo label="Punto de retorno">
                  <LocationInputCot placeholder="Igual al origen" value={form.punto_retorno} mapsLoaded={mapsLoaded}
                    onChange={v=>{setForm(p=>({...p,punto_retorno:v}));setRetornoPlace(null);olvidarRenombreRuta("retorno");setKmCongelado(null);}}
                    onSelect={p=>{setKmCongelado(null);olvidarRenombreRuta("retorno");setRetornoPlace(coordValida(p.lat,p.lng)?{placeId:p.placeId||"",lat:p.lat,lng:p.lng,fuente:p.placeId?"lista":"coordenadas"}:null);if(p.address)setForm(prev=>({...prev,punto_retorno:p.address}));}}/>
                  <CoordsDePunto place={retornoPlace} texto={form.punto_retorno} buscando={porGeocodificar.includes("retorno")} fallo={geoFallo.includes("retorno")} vacioDice="Vacío: la vuelta llega al punto de origen."/>
                  <AvisoRenombreMapa estado={renombreRuta.retorno} onVolver={()=>volverNombreRuta("retorno")} onReintentar={()=>reintentarNombreRuta("retorno")}/>
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
                {origenPlace&&destinoPlace&&coordValida(origenPlace.lat,origenPlace.lng)&&coordValida(destinoPlace.lat,destinoPlace.lng)&&paradas.filter(coordsOk).length<2&&(
                  <MapaRutaServicio origen={origenPlace} destino={destinoPlace} retorno={retornoPlace} vuelve={vuelve}
                    nombres={{origen:form.origen,destino:form.destino,retorno:form.punto_retorno}} onMover={moverPuntoRuta}/>
                )}
                {faltaMigracionCoords&&<p className="md:col-span-3 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">⚠ La cotización se guardó, pero SIN las coordenadas de la ruta: falta correr <span className="font-mono">supabase/cotizaciones-02-ruta-coords.sql</span>. Al reabrirla se buscarán de nuevo por el texto.</p>}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Parámetros de costing</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Campo label={esFijoForm?"Km diarios":"Km del servicio"} req hint={calculandoKm?"⏳ Calculando con Google Maps...":errorKm||avisoRet||(kmBase!==null?(vuelve?`📍 Google Maps: ida ${kmBase} km + retorno ${kmRet??kmBase} km${kmRet===null?" (estimado igual a la ida)":""}`:"📍 Calculado con Google Maps"):undefined)}><input type="number" min={0} className={iCls("font-mono"+(errorKm?" border-red-300 bg-red-50":avisoRet?" border-amber-300 bg-amber-50":calculandoKm?" border-amber-300 bg-amber-50":kmBase!==null?" border-green-300 bg-green-50":""))} placeholder="0" value={form.km} onChange={e=>{setForm(p=>({...p,km:e.target.value}));setKmBase(null);setErrorKm("");}}/></Campo>
                <Campo label="Días de conductor"><div className="flex items-center gap-1"><button onClick={()=>setDiasCond(Math.max(1,diasCond-1))} className="w-9 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold">-</button><span className="flex-1 text-center font-black text-[#0b315f]">{diasCond}</span><button onClick={()=>setDiasCond(Math.min(30,diasCond+1))} className="w-9 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold">+</button></div></Campo>
                <Campo label="Peajes S/"><input type="number" min={0} className={iCls()} placeholder="0" value={peajesF||""} onChange={e=>setPeajesF(Number(e.target.value))}/></Campo>
                <Campo label="Costo interno S/"><input type="number" min={0} className={iCls()} placeholder="0" value={form.costo_estimado} onChange={f("costo_estimado")}/></Campo>
              </div>
              {!esFijoForm&&form.tipo_servicio==="multi_dia"&&<div className="mt-3 rounded-xl bg-purple-50 border border-purple-200 p-4 grid grid-cols-2 gap-4"><p className="col-span-2 text-[10px] font-black text-purple-700 uppercase">🏕️ Costos multi-día</p><Campo label="Pernocte bus S/"><input type="number" min={0} className={iCls()} value={pernocteF||""} onChange={e=>setPernocteF(Number(e.target.value))}/></Campo><Campo label="Viáticos chofer S/"><input type="number" min={0} className={iCls()} value={viaticosF||""} onChange={e=>setViaticosF(Number(e.target.value))}/></Campo></div>}
              {esFijoForm&&<div className="mt-3 rounded-xl bg-green-50 border border-green-200 p-4 grid grid-cols-2 gap-4 items-end"><Campo label={`Precio/día confirmado ${simbItems} (con IGV)`}><input type="number" min={0} className={iCls("font-mono font-bold")} placeholder="0.00" value={form.precio_dia} onChange={f("precio_dia")}/>{monedaItems==="USD"&&precioDiaPENForm!=null&&<p className="text-[10px] text-gray-500 mt-0.5">Se guarda en soles: {fmtS(precioDiaPENForm)}</p>}</Campo>{form.precio_dia&&Number(form.precio_dia)>0&&<div className="rounded-xl bg-green-100 border border-green-300 px-4 py-3"><p className="text-[10px] font-bold text-green-700 uppercase">Estimado mensual (×26)</p><p className="font-black text-xl text-green-700">{fmtM(Number(form.precio_dia)*26,monedaItems)}</p></div>}</div>}
            </div>

            {form.tipo_vehiculo&&<SugerenciaEnVivo origen={form.origen} destino={form.destino} tipoVehId={form.tipo_vehiculo} tipoServ={form.tipo_servicio} equip={form.equipamiento} km={kmNum} dias={diasCond} peajes={peajesF} pernocte={pernocteF} viaticos={viaticosF} modoServ={form.modo_servicio} tarifas={tarifas} paramsDB={paramsDB} preciosDB={preciosDB} onAplicar={aplicarPrecio} moneda={monedaItems} tc={tcItems}/>}

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
                <div className="col-span-2 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-center">Días</div>
                <div className="col-span-2 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-center">Cant.</div>
                <div className="col-span-2 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-center">Pax</div>
                <div className="col-span-2 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-right">P. Unit. {simbItems}</div>
                <div className="col-span-1 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-center">Dto.%</div>
                <div className="col-span-2 text-[9px] font-bold uppercase tracking-wide text-gray-400 text-right">Total</div>
                <div className="col-span-1"/>
              </div>
              <div className="space-y-2">
                {items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return(<div key={i} className="grid grid-cols-12 gap-2 items-start bg-gray-50 rounded-xl p-2"><div className="col-span-12"><label className="block text-[9px] font-bold uppercase tracking-wide text-gray-400 mb-0.5">Descripción</label><textarea rows={2} className={iCls("resize-y min-h-[60px] leading-snug")} placeholder="Descripción del servicio" value={it.descripcion} onChange={e=>{updItem(i,"descripcion",e.target.value);e.target.style.height="auto";e.target.style.height=e.target.scrollHeight+"px";}} style={{overflow:"hidden"}}/></div><div className="col-span-3 md:col-span-2"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">Días</label><input type="number" min="1" className={iCls("text-center")} value={it.dias} onChange={e=>updItem(i,"dias",e.target.value)}/></div><div className="col-span-3 md:col-span-2"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">Cant.</label><input type="number" min="1" className={iCls("text-center")} value={it.cantidad} onChange={e=>updItem(i,"cantidad",e.target.value)}/></div><div className="col-span-3 md:col-span-2"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">Pax</label><input type="number" min="1" className={iCls("text-center")} placeholder="pax" title="Asientos CONTRATADOS para este ítem. Es lo que imprime la liquidación — no la capacidad del bus que se asigne el día del servicio." value={it.pax_contratado||""} onChange={e=>updItem(i,"pax_contratado",e.target.value)}/></div><div className="col-span-6 md:col-span-2"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">P. Unit.</label><input type="number" min="0" className={iCls("text-right")} placeholder="0.00" value={it.precio_unit||""} onChange={e=>updItem(i,"precio_unit",e.target.value)}/></div><div className="col-span-3 md:col-span-1"><label className="block md:hidden text-[9px] font-bold text-gray-400 mb-0.5">Dto.%</label><input type="number" min="0" max="100" className={iCls("text-center")} placeholder="0" value={it.descuento_pct||""} onChange={e=>updItem(i,"descuento_pct",e.target.value)}/></div><div className="col-span-9 md:col-span-2 text-right font-bold text-sm text-gray-800 pr-2 flex md:block items-center justify-end gap-1"><span className="md:hidden text-[9px] font-normal text-gray-400">Total:</span>{fmtM(totPant.lineas[i]??tf,monedaItems)}</div><div className="col-span-3 md:col-span-1 flex justify-end">{items.length>1&&<button onClick={()=>delItem(i)} className="w-7 h-7 rounded-lg text-red-400 hover:bg-red-50 font-bold text-sm">✕</button>}</div>{(flota.length>0||flotaTercero.length>0)&&<div className="col-span-12 mt-1"><select className="w-full border border-gray-100 rounded-lg px-2 py-1.5 text-xs text-gray-500 bg-white focus:outline-none focus:border-[#0b315f]" value={it.vehiculo_flota_id?`f_${it.vehiculo_flota_id}`:it.vehiculo_tercero_id?`t_${it.vehiculo_tercero_id}`:""} onChange={e=>{const val=e.target.value;setItems(prev=>prev.map((x,xi)=>xi!==i?x:val.startsWith("f_")?{...x,vehiculo_flota_id:Number(val.slice(2)),vehiculo_tercero_id:null}:val.startsWith("t_")?{...x,vehiculo_flota_id:null,vehiculo_tercero_id:Number(val.slice(2))}:{...x,vehiculo_flota_id:null,vehiculo_tercero_id:null}));}}><option value="">🚌 Asignar vehículo a este ítem (opcional)</option>{flota.length>0&&<optgroup label="Flota propia">{flota.map(v=><option key={v.id} value={`f_${v.id}`}>{v.placa}{v.categoria?` · ${v.categoria}`:""}{v.marca?` ${v.marca}`:""}{v.capacidad_pasajeros?` (${v.capacidad_pasajeros}p)`:""}</option>)}</optgroup>}{flotaTercero.length>0&&<optgroup label="Tercerizado">{flotaTercero.map(v=><option key={v.id} value={`t_${v.id}`}>{v.placa}{v.categoria?` · ${v.categoria}`:""}{v.empresa_nombre?` — ${v.empresa_nombre}`:""}</option>)}</optgroup>}</select></div>}</div>);})}
              </div>
              <div className="flex justify-end mt-4">
                <div className="w-full md:w-72 space-y-1.5 bg-gray-50 rounded-xl p-4">
                  {form.incluye_igv&&<>
                    <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal (sin IGV)</span><span className="font-bold">{fmtM(subtotalPant,monedaItems)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-500">IGV 18%</span><span className="font-bold">{fmtM(igv,monedaItems)}</span></div>
                  </>}
                  <div className="flex justify-between text-base border-t pt-2" style={{borderColor:"#0b315f"}}>
                    <span className="font-black">{esFijoForm?"Total/día":"Total"}</span>
                    <span className="font-black" style={{color:"#0b315f"}}>{fmtM(total,monedaItems)}</span>
                  </div>
                  {monedaItems==="USD"&&<p className="text-[10px] text-gray-500 text-right" title="Lo que se guarda: los importes de la cotización siempre están en soles.">Se guarda en soles: {fmtS(totPEN.total)} (TC {tcItems})</p>}
                  {!form.incluye_igv&&<p className="text-[10px] text-amber-700 font-semibold text-right">No incluye IGV</p>}
                  {esFijoForm&&<div className="flex justify-between text-sm"><span className="text-gray-400">Mes est. (×26)</span><span className="font-black text-green-600">{fmtM(total*26,monedaItems)}</span></div>}
                </div>
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Consideraciones <span className="normal-case font-normal text-blue-500">→ aparecen en el PDF</span></p>
              {(()=>{
                // La plantilla del PDF: de ella salen las condiciones al crear la cotización (y quedan
                // escritas en ella). En una nueva la elige la regla; aquí se puede cambiar a mano.
                const opciones=opcionesPlantilla(plantillas,[plantillaForm]);
                const ambar=!plantillaFijada&&(usoAuto.codigo==="regla_inactiva"||usoAuto.codigo==="regla_no_sirve_ia"||usoAuto.codigo==="sin_plantilla"||usoAuto.codigo==="sin_reglas"||usoAuto.codigo==="lectura_fallida");
                const rotulo=plantillaFijada?.origen==="manual"?"elegida a mano":plantillaFijada?.origen==="guardada"?"la guardada en esta cotización"
                  :({cargando:"comprobando las plantillas…",regla:`por la regla ${usoAuto.celda}`,principal:`plantilla principal (no hay regla para ${usoAuto.celda})`,
                    regla_inactiva:"plantilla principal (la regla no se puede usar)",regla_no_sirve_ia:"plantilla principal (la regla no se puede usar)",
                    sin_reglas:"sin reglas de uso: la de siempre",sin_plantilla:"no hay una plantilla principal activa",lectura_fallida:"no se pudieron leer las plantillas"} as Record<string,string>)[usoAuto.codigo]??"";
                // Las condiciones en pantalla vienen de OTRA plantilla (se tocaron y la plantilla cambió): se ofrece cargarlas.
                const otraPl=consid.plantilla!==plantillaForm&&considEditada!==null&&!considPendiente?filaForm:null;
                return(<div className="rounded-xl border border-gray-200 bg-gray-50 p-3 mb-3 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500" htmlFor="plantilla-pdf-form">Plantilla del PDF</label>
                    <select id="plantilla-pdf-form" className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:border-[#0b315f] max-w-full" value={plantillaForm} disabled={considPendiente} onChange={e=>setPlantillaFijada({id:e.target.value,origen:"manual"})}>
                      {opciones.map(p=><option key={p.id} value={p.id}>{rotuloOpcion(p)}</option>)}
                    </select>
                    <span className="text-[11px] text-gray-500">{rotulo}</span>
                    {plantillaFijada?.origen==="manual"&&!editandoId&&<button type="button" onClick={()=>setPlantillaFijada(null)} className="text-[11px] font-bold text-[#0b315f] hover:underline">↺ Usar la de la regla</button>}
                  </div>
                  {considPendiente&&<p className="text-[11px] text-gray-500">Leyendo la plantilla de esta cotización…</p>}
                  {ambar&&usoAuto.detalle&&<p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">⚠ {usoAuto.detalle}</p>}
                  {!plantillaFijada&&usoAuto.codigo==="lectura_fallida"&&<p className="text-[11px] text-amber-800">Se usa la corporativa y, si no se pudo leer, las condiciones de fábrica.</p>}
                  {avisoConsidForm&&<p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">⚠ {avisoConsidForm}</p>}
                  {otraPl&&<p className="text-[11px] text-gray-600">Las condiciones de abajo no son las de «{otraPl.nombre||otraPl.id}» (se editaron{consid.plantilla?` o vienen de «${nombrePlantilla(consid.plantilla)||consid.plantilla}»`:""}). <button type="button" className="font-bold text-[#0b315f] hover:underline" onClick={()=>{const n=consid.incluye.length+consid.no_incluye.length+consid.generales.length+(consid.reserva?.length??0)+(consid.reserva_resumen?.length??0);if(confirm(`Se reemplazan las ${n} condiciones de abajo por las de la plantilla «${otraPl.nombre||otraPl.id}». ¿Continuar?`))setConsidEditada(null);}}>Cargar las condiciones de «{otraPl.nombre||otraPl.id}»</button></p>}
                  <p className="text-[10px] text-gray-400">Al guardar, las condiciones de abajo quedan escritas en la cotización y son las que imprime su PDF; cambiar después la plantilla no las cambia.</p>
                </div>);
              })()}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {([{key:"incluye" as const,label:"✅ Servicio incluye",color:"#166534",bg:"#f0fdf4",border:"#86efac"},{key:"no_incluye" as const,label:"❌ No incluye",color:"#991b1b",bg:"#fff5f5",border:"#fca5a5"}]).map(({key,label,color,bg,border})=>(
                  <div key={key} className="rounded-xl border-2 p-3 space-y-2" style={{background:bg,borderColor:border}}><p className="text-xs font-black" style={{color}}>{label}</p><div className="space-y-1.5">{consid[key].map((item,i)=><div key={i} className="flex gap-2 items-center"><input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white" value={item} onChange={e=>setConsid(prev=>({...prev,[key]:prev[key].map((it,idx)=>idx===i?e.target.value:it)}))}/><button onClick={()=>setConsid(prev=>({...prev,[key]:prev[key].filter((_,idx)=>idx!==i)}))} className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button></div>)}</div><button onClick={()=>setConsid(prev=>({...prev,[key]:[...prev[key],""]}))  } className="text-[10px] font-bold hover:underline" style={{color}}>+ Agregar ítem</button></div>
                ))}
              </div>
              <div className="rounded-xl border-2 p-3 space-y-2 mt-4" style={{background:"#eef3f8",borderColor:"#93c5fd"}}>
                <p className="text-xs font-black text-[#0b315f]">📋 Consideraciones generales</p>
                <div className="space-y-1.5">{consid.generales.map((item,i)=><div key={i} className="flex gap-2 items-center"><input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white" value={item} onChange={e=>setConsid(prev=>({...prev,generales:prev.generales.map((it,idx)=>idx===i?e.target.value:it)}))}/><button onClick={()=>setConsid(prev=>({...prev,generales:prev.generales.filter((_,idx)=>idx!==i)}))} className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button></div>)}</div>
                <div className="flex items-center gap-4"><button onClick={()=>setConsid(prev=>({...prev,generales:[...prev.generales,""]}))} className="text-[10px] font-bold text-[#0b315f] hover:underline">+ Agregar ítem</button><button onClick={()=>setConsid(prev=>({...prev,generales:[...considDePlantilla(filaForm).generales]}))} title={`Vuelve a las consideraciones generales de la plantilla «${filaForm?.nombre||plantillaForm}»`} className="text-[10px] text-gray-400 hover:underline">↺ Restaurar las de la plantilla</button></div>
              </div>
              {(()=>{
                // La política de reserva, cambios y cancelación (supabase/cotizaciones-06): la copia la
                // plantilla al crear y SOLO la imprime el diseño corporativo, después de las generales.
                const reserva=consid.reserva??[];
                const corp=disenoDe(filaForm??{id:plantillaForm})==="corporativo";
                if(!corp&&reserva.length===0)return null;
                return(<div className="rounded-xl border-2 p-3 space-y-2 mt-4" style={{background:"#f8fafc",borderColor:"#cbd5e1"}}>
                  <p className="text-xs font-black text-[#0b315f]">📅 Reserva, cambios y cancelación</p>
                  {!corp&&<p className="text-[10px] text-gray-500">El diseño de esta plantilla no imprime la política de reserva: solo la imprime el corporativo.</p>}
                  {reserva.length===0&&<p className="text-[10px] text-gray-500">Sin política de reserva: el PDF no imprime este bloque.</p>}
                  <div className="space-y-1.5">{reserva.map((item,i)=><div key={i} className="flex gap-2 items-center"><input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white" value={item} onChange={e=>setConsid(prev=>({...prev,reserva:(prev.reserva??[]).map((it,idx)=>idx===i?e.target.value:it)}))}/><button onClick={()=>setConsid(prev=>({...prev,reserva:(prev.reserva??[]).filter((_,idx)=>idx!==i)}))} className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button></div>)}</div>
                  <div className="flex items-center gap-4"><button onClick={()=>setConsid(prev=>({...prev,reserva:[...(prev.reserva??[]),""]}))} className="text-[10px] font-bold text-[#0b315f] hover:underline">+ Agregar ítem</button><button onClick={()=>setConsid(prev=>({...prev,reserva:[...(considDePlantilla(filaForm).reserva??[])]}))} title={`Vuelve a la política de reserva de la plantilla «${filaForm?.nombre||plantillaForm}»`} className="text-[10px] text-gray-400 hover:underline">↺ Restaurar la de la plantilla</button></div>
                  {corp&&reserva.length>0&&(()=>{
                    // Su RESUMEN (supabase/cotizaciones-08): con él, el PDF imprime estos puntos y el enlace
                    // (con QR) a la política completa de ESTA cotización; sin resumen, la política entera.
                    const resumen=consid.reserva_resumen??[];
                    const dePl=considDePlantilla(filaForm).reserva_resumen??[];
                    return(<div className="border-t border-slate-200 pt-2 space-y-1.5">
                      <p className="text-[11px] font-black text-[#0b315f]">Resumen para el PDF y el WhatsApp</p>
                      <p className="text-[10px] text-gray-500">{resumen.length?"El PDF imprime estos puntos y, debajo, el enlace con su QR a la política completa de esta cotización (la de arriba).":"Sin resumen: el PDF imprime la política entera."} Si la cotización no tiene enlace (falta correr {SQL_RESUMEN_CONDICIONES}), se imprime la política entera. No lleves aquí teléfonos, correos, enlaces ni números largos.</p>
                      <div className="space-y-1.5">{resumen.map((item,i)=><div key={i} className="flex gap-2 items-center"><input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white" value={item} onChange={e=>setConsid(prev=>({...prev,reserva_resumen:(prev.reserva_resumen??[]).map((it,idx)=>idx===i?e.target.value:it)}))}/><button onClick={()=>setConsid(prev=>{const r=(prev.reserva_resumen??[]).filter((_,idx)=>idx!==i);if(r.length)return{...prev,reserva_resumen:r};const{reserva_resumen:_q,...resto}=prev;return resto;})} className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button></div>)}</div>
                      <div className="flex items-center gap-4"><button onClick={()=>setConsid(prev=>({...prev,reserva_resumen:[...(prev.reserva_resumen??[]),""]}))} className="text-[10px] font-bold text-[#0b315f] hover:underline">+ Agregar punto</button>{dePl.length>0&&<button onClick={()=>setConsid(prev=>({...prev,reserva_resumen:[...dePl]}))} title={`Vuelve al resumen de la plantilla «${filaForm?.nombre||plantillaForm}»`} className="text-[10px] text-gray-400 hover:underline">↺ Restaurar el de la plantilla</button>}</div>
                    </div>);
                  })()}
                </div>);
              })()}
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
                contexto={{modoServicio:form.modo_servicio,fechaServicio:form.fecha_servicio||null,sentido:"ida",horaSalidaForm:form.hora_ida}}
                // El paradero 1 y el último están atados al origen/destino del formulario (el efecto
                // de sincronización les copia sus coordenadas): arrastrarlos mueve ESE punto, o el
                // efecto los devolvería a su sitio. placeId vacío: mandan las coordenadas.
                onMoverExtremo={(t,lat,lng)=>moverPuntoRuta(t==="inicio"?"origen":"destino",lat,lng)}
              />
            </div>

            {/* Recorrido del RETORNO — fijos con hora de retorno y eventuales que vuelven (no multi-día, que
                tiene su cronograma). Nunca se deduce de la ida: termina en el punto de retorno, o en el origen. */}
            {retornoConRecorrido&&(
              <div className="rounded-2xl border-2 p-4" style={{borderColor:paradasRetorno.length<2?"#c4b5fd":"#a5b4fc",background:paradasRetorno.length<2?"#f5f3ff":"#eef2ff"}}>
                <div className="flex items-center gap-2 border-b pb-1 mb-3" style={{borderColor:paradasRetorno.length<2?"#c4b5fd":"#a5b4fc"}}>
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={{color:"#5b21b6"}}>{esFijoForm?"↩ Paraderos del RETORNO":"↩ Puntos del recorrido del RETORNO"}</p>
                  {paradasRetorno.length<2
                    ?<span className="text-[9px] font-black px-2 py-0.5 rounded-full" style={{background:"#ddd6fe",color:"#5b21b6"}}>Opcional · {paradasRetorno.length} puntos</span>
                    :<span className="text-[9px] font-black px-2 py-0.5 rounded-full" style={{background:"#a5b4fc",color:"#1e1b4b"}}>✓ {paradasRetorno.length} puntos</span>
                  }
                  {form.hora_retorno&&<span className="text-[9px] text-gray-400 ml-auto">Salida: {form.hora_retorno}</span>}
                </div>
                <p className="text-[10px] text-gray-500 mb-3">Define los puntos del trayecto de regreso. Las paradas pueden diferir de la IDA (calzadas, dirección de vía, lat/lng distintas).</p>
                <ParadasBuilder
                  paradas={paradasRetorno} onChange={setParadasRetorno} tipo={form.tipo_servicio}
                  mapsLoaded={mapsLoaded}
                  origenNombre={form.destino} destinoNombre={finRetorno.nombre}
                  origenLat={destinoPlace?.lat?String(destinoPlace.lat):""} origenLng={destinoPlace?.lng?String(destinoPlace.lng):""}
                  destinoLat={finRetorno.place?String(finRetorno.place.lat):""} destinoLng={finRetorno.place?String(finRetorno.place.lng):""}
                  horaIda={form.hora_retorno} horaRetorno=""
                  // Sin onMoverExtremo: los extremos del retorno no están atados al formulario.
                  contexto={{modoServicio:form.modo_servicio,fechaServicio:(esFijoForm?form.fecha_servicio:(form.fecha_retorno||form.fecha_servicio))||null,sentido:"retorno",horaSalidaIda:paradas.find(p=>p.tipo==="inicio")?.hora||form.hora_ida||null,horaSalidaForm:form.hora_retorno}}
                />
              </div>
            )}

            {form.tipo_vehiculo&&form.tipo_servicio&&form.origen&&form.destino&&<div className="rounded-xl border px-4 py-3 flex items-start gap-3" style={{background:"#f0fdf4",borderColor:"#86efac"}}><input type="checkbox" id="chk_tar" checked={guardarTar} onChange={e=>setGuardarTar(e.target.checked)} className="w-4 h-4 mt-0.5 accent-green-600 flex-shrink-0"/><label htmlFor="chk_tar" className="cursor-pointer text-xs text-green-800"><b>Guardar en Tarifario</b> — {form.origen}→{form.destino} · {paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo)?.nombre||form.tipo_vehiculo} · {form.modo_servicio.toUpperCase()}{form.moneda==="USD"&&<span className="block text-green-700/80 mt-0.5">El tarifario guarda SOLES sin IGV: se registra el equivalente al tipo de cambio de la cotización, no los dólares.</span>}</label></div>}

            {bloqueoMoneda&&<p className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">⛔ No se puede guardar todavía: {bloqueoMoneda}</p>}
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

        <section className="space-y-2 min-w-0">
          <div className="flex gap-2">
            <div className="relative flex-1 min-w-0"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span><input className="w-full border rounded-xl pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]" placeholder="Buscar cliente, RUC, ruta, asunto o N°…" value={busqueda} onChange={e=>setBusqueda(e.target.value)}/>{busqueda&&<button onClick={()=>{setBusqueda("");setBusquedaDeb("");}} className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700 text-sm" title="Limpiar búsqueda" aria-label="Limpiar búsqueda">✕</button>}</div>
            <div className="flex items-center px-3 py-2 bg-gray-50 border rounded-xl text-xs text-gray-500 whitespace-nowrap">{listaVigente?<span><b className="text-gray-700">{filtradas.length}</b> de {totC}</span>:cargandoLista?"Cargando…":"—"}</div>
          </div>
          {busquedaDeb.trim()&&periodo!=="todo"&&<p className="text-[11px] text-gray-500 px-1">Buscando solo en <b>{rotuloPeriodo.toLowerCase()}</b> · <button onClick={()=>setPeriodo("todo")} className="font-bold text-[#0b315f] underline hover:no-underline">Buscar en todas las fechas</button></p>}
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
            {PERIODOS.map(p=>(
              <button key={p} onClick={()=>setPeriodo(p)} className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border whitespace-nowrap transition-colors ${periodo===p?"text-white border-[#0b315f]":"bg-white text-gray-600 border-gray-200 hover:border-[#0b315f] hover:text-[#0b315f]"}`} style={periodo===p?{background:"#0b315f"}:undefined}>{ETIQUETA_PERIODO[p]}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {periodo==="rango"&&(
              <div className="flex items-center gap-1.5 flex-wrap">
                <label className="text-[11px] font-bold text-gray-400 uppercase">Desde</label><input type="date" className="border rounded-xl px-2.5 py-2 text-sm" value={rangoManual.desde} onChange={e=>setRangoManual(r=>({...r,desde:e.target.value}))}/>
                <label className="text-[11px] font-bold text-gray-400 uppercase">Hasta</label><input type="date" className="border rounded-xl px-2.5 py-2 text-sm" value={rangoManual.hasta} onChange={e=>setRangoManual(r=>({...r,hasta:e.target.value}))}/>
              </div>
            )}
            <select className="border rounded-xl px-3 py-2.5 text-sm" value={eje} onChange={e=>setEje(e.target.value as EjeFecha)} title="Con qué fecha se mide el periodo">{(["emision","servicio"] as EjeFecha[]).map(x=><option key={x} value={x}>{ETIQUETA_EJE[x]}</option>)}</select>
            <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroModo} onChange={e=>setFiltroModo(e.target.value)}><option value="todos">Eventual + Fijo</option><option value="eventual">Solo Eventual</option><option value="fijo">Solo Fijo</option></select>
            <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroEst} onChange={e=>setFiltroEst(e.target.value)}><option value="todos">Todos estados</option><option value="borrador">Borradores</option><option value="pendiente">Pendientes</option><option value="enviado">Enviadas</option><option value="aprobado">Aprobadas</option><option value="rechazado">Rechazadas</option></select>
            {hayFiltros&&<button onClick={limpiarFiltros} className="px-3 py-2.5 rounded-xl text-xs font-bold border text-gray-600 hover:bg-gray-50">Limpiar filtros</button>}
          </div>
          {eje==="servicio"&&periodo!=="todo"&&<p className="text-[11px] text-gray-400 px-1">Las cotizaciones sin fecha de servicio no aparecen con este eje.</p>}
          {motivoRango&&<p className="text-xs font-bold rounded-xl px-3 py-2 border" style={{background:"#fffbeb",borderColor:"#fcd34d",color:"#92400e"}}>⚠ {motivoRango}</p>}
          {errorVigente&&<div className="text-xs font-bold rounded-xl px-3 py-2 border flex items-center gap-2 flex-wrap" style={{background:"#fef2f2",borderColor:"#fca5a5",color:"#991b1b"}}><span>No se pudieron leer las cotizaciones: {errorVigente}</span><span>·</span><button onClick={()=>cargarLista()} disabled={cargandoLista} className="underline hover:no-underline disabled:opacity-50">{cargandoLista?"Reintentando…":"Reintentar"}</button></div>}
        </section>

        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">

          {/* ── Vista cards (móvil/tablet) ── */}
          <div className="md:hidden divide-y divide-gray-100">
            {motivoRango||(errorVigente&&!listaVigente)
              ? <div className="p-8 text-center text-xs text-gray-400">{motivoRango?"Sin consultar: el rango no está completo.":"No se muestran cotizaciones porque la lectura falló (ver arriba)."}</div>
              : !listaVigente
              ? <div className="p-10 text-center text-gray-400"><div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>Cargando...</div></div>
              : filtradas.length===0
                ? <div className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">📄</p><p>{totC===0?`No hay cotizaciones en ${rotuloPeriodo.toLowerCase()}`:"Ninguna cotización coincide con la búsqueda o los filtros"}</p></div>
                : visibles.map(c=>{
                    const esBorrador=c.estado==="borrador";const est=ESTADO_CFG[c.estado]||ESTADO_CFG.pendiente;const margen=Number(c.margen_estimado||0);const esFijo=c.modo_servicio==="fijo";const tieneDsc=c.descuento_solicitado&&!c.descuento_autorizado;const tieneDec=!!(c.precio_cotizador||c.precio_tarifario);
                    return(
                      <div key={c.id} className={`p-4 space-y-2.5 ${esBorrador?"opacity-70":""} ${tieneDsc?"bg-orange-50":""}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono font-black text-[#0b315f] text-sm">#{c.numero_cotizacion||String(c.id).padStart(5,"0")}</span>
                            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${esFijo?"bg-green-100 text-green-700":"bg-blue-100 text-blue-700"}`}>{esFijo?"📅 FIJO":"📋 EVEN."}</span>
                            {tieneDsc&&<span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 animate-pulse">🙋 Dscto.</span>}
                          </div>
                          <select value={c.estado} onChange={e=>cambiarEstado(c,e.target.value as EstadoCot)} disabled={estadoEnCurso!==null} title={estadoEnCurso===c.id?"Guardando el estado…":undefined} className="text-[10px] font-bold px-2 py-1 rounded-lg border-0 cursor-pointer flex-shrink-0 disabled:opacity-50 disabled:cursor-wait" style={{background:est.bg,color:est.color}}>
                            {(["borrador","pendiente","enviado","aprobado","rechazado"] as EstadoCot[]).map(s=>(
                              <option key={s} value={s} disabled={s!==c.estado&&!TRANSICIONES[c.estado].includes(s)}>{s===c.estado?"✓ ":TRANSICIONES[c.estado].includes(s)?"→ ":"✕ "}{ESTADO_CFG[s].label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="font-bold text-gray-800 text-sm">{nomCl(c.cliente_id)}{c.atencion&&<span className="font-normal text-gray-400 text-xs"> · {c.atencion}</span>}</div>
                        <div className="text-xs text-gray-500 truncate">{c.origen} → {c.destino}{c.asunto&&<span className="text-gray-400"> · {c.asunto}</span>}</div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-gray-800" title={tituloSoles(Number(c.precio_cliente||0),normalizarMoneda(c.moneda),c.tipo_cambio)}>{fmtCot(Number(c.precio_cliente||0),normalizarMoneda(c.moneda),c.tipo_cambio)}</span>
                            {esFijo&&<span className="text-[10px] text-gray-400">/día</span>}
                            <span className="text-xs font-bold" title="Margen estimado, en soles" style={{color:margen>=0?"#166534":"#991b1b"}}>{fmtS(margen)}</span>
                          </div>
                          <span className="text-xs text-gray-400">{fmtF(c.fecha_servicio)}</span>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={()=>conDetalle(c,"editar",editarCot)} disabled={!!detalleCargando} className="flex-1 py-2 rounded-xl text-xs font-bold border hover:bg-gray-50 text-gray-700 disabled:opacity-50">{cargandoEsta(c.id,"editar")?"…":"✏️ Editar"}</button>
                          <button onClick={()=>conDetalle(c,"duplicar",duplicarCotizacion)} disabled={!!detalleCargando} className="py-2 px-3 rounded-xl text-xs font-bold border hover:bg-purple-50 disabled:opacity-50" style={{color:"#7c3aed",borderColor:"#ddd6fe"}} title="Duplicar cotización">{cargandoEsta(c.id,"duplicar")?"…":"📋"}</button>
                          <button onClick={()=>conDetalle(c,"pdf",abrirModalPlantilla)} disabled={!!detalleCargando} className="flex-1 py-2 rounded-xl text-xs font-bold border disabled:opacity-50" style={{background:"#eef3f8",color:"#0b315f"}}>{cargandoEsta(c.id,"pdf")?"…":"📄 PDF"}</button>
                          <button onClick={()=>conDetalle(c,"ficha",abrirFicha)} disabled={fichaCargando!==null||!!detalleCargando} className="flex-1 py-2 rounded-xl text-xs font-bold border disabled:opacity-40" style={{background:"#f5f3ff",color:"#6d28d9",borderColor:"#ddd6fe"}} title="Ficha Técnica de Ruta — puntos de entrada y retorno, sin precios">{fichaCargando===c.id||cargandoEsta(c.id,"ficha")?"⏳ Ficha…":"🗺️ Ficha"}</button>
                          <button onClick={()=>conDetalle(c,"reserva",convertirAReserva)} disabled={c.estado!=="aprobado"||!!detalleCargando} className="flex-1 py-2 rounded-xl text-xs font-bold border disabled:opacity-30" style={{background:"#dcfce7",color:"#166534"}}>{cargandoEsta(c.id,"reserva")?"…":"→ Res."}</button>
                          {rolUsuario==="admin"&&<button onClick={()=>setModalEliminar(c)} className="py-2 px-3 rounded-xl text-xs font-bold border hover:bg-red-50" style={{color:"#dc2626",borderColor:"#fca5a5"}} title="Eliminar cotización">🗑️</button>}
                        </div>
                        {tieneDec&&<button onClick={()=>setPanelId(panelId===c.id?null:c.id)} className={`text-[10px] font-black px-2 py-1 rounded-full ${tieneDsc?"bg-orange-100 text-orange-700":"bg-[#eef3f8] text-[#0b315f]"}`}>{tieneDsc?"🙋 Descuento pendiente":"💡 Ver precios"}</button>}
                        {panelId===c.id&&<PanelDecision c={c} onAct={refrescar}/>}
                      </div>
                    );
                  })
            }
          </div>

          {/* ── Vista tabla (desktop) ── */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0"}}>{["N°","Cliente","Ruta","Vehículo","Servicio","Fecha","Precio","Margen S/","Estado","Acciones"].map(h=><th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {motivoRango||(errorVigente&&!listaVigente)?<tr><td colSpan={10} className="p-8 text-center text-xs text-gray-400">{motivoRango?"Sin consultar: el rango no está completo.":"No se muestran cotizaciones porque la lectura falló (ver arriba)."}</td></tr>:!listaVigente?<tr><td colSpan={10} className="p-10 text-center text-gray-400"><div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin"/>Cargando...</div></td></tr>:filtradas.length===0?<tr><td colSpan={10}><div className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">📄</p><p>{totC===0?`No hay cotizaciones en ${rotuloPeriodo.toLowerCase()}`:"Ninguna cotización coincide con la búsqueda o los filtros"}</p></div></td></tr>:visibles.map(c=>{
                  const esBorrador=c.estado==="borrador";const est=ESTADO_CFG[c.estado]||ESTADO_CFG.pendiente;const margen=Number(c.margen_estimado||0);const vehParam=paramsDB.find(p=>p.tipo_vehiculo===c.tipo_vehiculo);const vehF=flota.find(v=>v.id===c.vehiculo_flota_id);const vehT=flotaTercero.find(v=>v.id===c.vehiculo_tercero_id);
                  const tieneDec=!!(c.precio_cotizador||c.precio_tarifario);const tieneDsc=c.descuento_solicitado&&!c.descuento_autorizado;const esFijo=c.modo_servicio==="fijo";const servLabel=[...SERVS_EVENTUAL,...SERVS_FIJO].find(s=>s.id===c.tipo_servicio)?.label||c.tipo_servicio||"";
                  return(<React.Fragment key={c.id}>
                    <tr className={`border-t hover:bg-gray-50 ${esBorrador?"opacity-70 italic":""}${tieneDsc?" bg-orange-50":""}`} style={{borderColor:"#f1f5f9"}}>
                      <td className="p-3 font-mono font-black text-[#0b315f] text-xs"><div>#{c.numero_cotizacion||String(c.id).padStart(5,"0")}</div><div className={`text-[9px] font-black px-1.5 py-0.5 rounded-full mt-0.5 inline-block ${esFijo?"bg-green-100 text-green-700":"bg-blue-100 text-blue-700"}`}>{esFijo?"📅 FIJO":"📋 EVENTUAL"}</div>{tieneDec&&<button onClick={()=>setPanelId(panelId===c.id?null:c.id)} className={`block mt-1 text-[9px] font-black px-1.5 py-0.5 rounded-full ${tieneDsc?"bg-orange-100 text-orange-700 animate-pulse":"bg-[#eef3f8] text-[#0b315f] hover:bg-blue-100"}`}>{tieneDsc?"🙋 Descuento":"💡 Precios"}</button>}</td>
                      <td className="p-3 max-w-[120px]"><div className="font-bold text-gray-800 truncate">{nomCl(c.cliente_id)}</div>{c.atencion&&<div className="text-xs text-gray-400 truncate">{c.atencion}</div>}</td>
                      <td className="p-3 max-w-[150px]"><div className="truncate text-gray-700 text-xs">{c.origen}→{c.destino}</div>{c.asunto&&<div className="text-[10px] text-gray-400 truncate">{c.asunto}</div>}</td>
                      <td className="p-3">{vehF?<p className="font-mono font-black text-xs text-[#0b315f]">{vehF.placa}</p>:vehT?<div><p className="font-mono font-black text-xs text-amber-700">{vehT.placa}</p><p className="text-[9px] text-amber-600">🤝 {vehT.empresa_nombre}</p></div>:vehParam?<div className="text-xs text-gray-500">{vehParam.icono||"🚌"} {vehParam.nombre}</div>:<span className="text-gray-300 text-xs">—</span>}</td>
                      <td className="p-3"><span className="text-[10px] font-bold text-gray-600">{servLabel}</span>{(c.paradas_n??0)>0&&<span className="text-[10px] text-[#be185d] font-bold block">🚏 {c.paradas_n} paradas</span>}</td>
                      <td className="p-3 text-xs text-gray-500">{fmtF(c.fecha_servicio)}{c.hora_ida&&<div className="text-gray-400">{c.hora_ida}</div>}</td>
                      <td className="p-3 font-bold text-gray-800" title={tituloSoles(Number(c.precio_cliente||0),normalizarMoneda(c.moneda),c.tipo_cambio)}>{fmtCot(Number(c.precio_cliente||0),normalizarMoneda(c.moneda),c.tipo_cambio)}{esFijo&&<p className="text-[10px] text-gray-400 font-normal">/día</p>}{esFijo&&c.precio_mes_estimado&&<p className="text-[10px] text-green-600 font-bold">~{fmtCot(c.precio_mes_estimado,normalizarMoneda(c.moneda),c.tipo_cambio)}/mes</p>}</td>
                      <td className="p-3 font-bold" title="Margen estimado, en soles" style={{color:margen>=0?"#166534":"#991b1b"}}>{fmtS(margen)}</td>
                      <td className="p-3" onClick={e=>e.stopPropagation()}>
                        <select value={c.estado} onChange={e=>cambiarEstado(c,e.target.value as EstadoCot)} disabled={estadoEnCurso!==null} title={estadoEnCurso===c.id?"Guardando el estado…":undefined} className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer disabled:opacity-50 disabled:cursor-wait" style={{background:est.bg,color:est.color}}>
                          {(["borrador","pendiente","enviado","aprobado","rechazado"] as EstadoCot[]).map(s=>(
                            <option key={s} value={s} disabled={s!==c.estado&&!TRANSICIONES[c.estado].includes(s)}>
                              {s===c.estado?"✓ ":TRANSICIONES[c.estado].includes(s)?"→ ":"✕ "}{ESTADO_CFG[s].label}
                            </option>
                          ))}
                        </select>
                        {c.estado==="enviado"&&c.medio_envio&&<p className="text-[9px] text-gray-400 mt-0.5 font-medium">{c.medio_envio==="WhatsApp"?"💬":c.medio_envio.startsWith("Correo")?"✉️":"📋"} {c.medio_envio}</p>}
                      </td>
                      <td className="p-3"><div className="flex gap-1 flex-wrap"><button onClick={()=>conDetalle(c,"editar",editarCot)} disabled={!!detalleCargando} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700 disabled:opacity-50" title="Editar">{cargandoEsta(c.id,"editar")?"…":"✏️"}</button><button onClick={()=>conDetalle(c,"duplicar",duplicarCotizacion)} disabled={!!detalleCargando} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-purple-50 disabled:opacity-50" style={{color:"#7c3aed",borderColor:"#ddd6fe"}} title="Duplicar cotización">{cargandoEsta(c.id,"duplicar")?"…":"📋"}</button><button onClick={()=>conDetalle(c,"pdf",abrirModalPlantilla)} disabled={!!detalleCargando} className="px-2 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-50" style={{background:"#eef3f8",color:"#0b315f"}}>{cargandoEsta(c.id,"pdf")?"…":"📄 PDF"}</button><button onClick={()=>conDetalle(c,"ficha",abrirFicha)} disabled={fichaCargando!==null||!!detalleCargando} className="px-2 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-40" style={{background:"#f5f3ff",color:"#6d28d9",borderColor:"#ddd6fe"}} title="Ficha Técnica de Ruta — puntos de entrada y retorno, sin precios">{fichaCargando===c.id||cargandoEsta(c.id,"ficha")?"⏳":"🗺️ Ficha"}</button><button onClick={()=>conDetalle(c,"reserva",convertirAReserva)} disabled={c.estado!=="aprobado"||!!detalleCargando} className="px-2 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-30" style={{background:"#dcfce7",color:"#166534"}}>{cargandoEsta(c.id,"reserva")?"…":"→Res"}</button>{rolUsuario==="admin"&&<button onClick={()=>setModalEliminar(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-red-50" style={{color:"#dc2626",borderColor:"#fca5a5"}} title="Eliminar cotización">🗑️</button>}</div></td>
                    </tr>
                    {panelId===c.id&&<tr><td colSpan={10} className="px-4 pb-3 pt-0"><PanelDecision c={c} onAct={refrescar}/></td></tr>}
                  </React.Fragment>);
                })}
              </tbody>
            </table>
          </div>
          {listaVigente&&filtradas.length>nVisibles&&<div className="px-4 py-3 border-t text-center"><button onClick={mostrarMas} className="px-4 py-2 rounded-xl text-xs font-bold border text-[#0b315f] border-[#0b315f]/30 hover:bg-[#eef3f8]">Mostrar {Math.min(PASO_LISTA,filtradas.length-nVisibles)} más (quedan {filtradas.length-nVisibles})</button></div>}
          {listaVigente&&sinColumnasLista.includes("paradas_n")&&<div className="px-4 py-2 border-t text-[11px] font-bold" style={{background:"#fffbeb",color:"#92400e"}}>⚠ Falta correr supabase/cotizaciones-03-indices-lista.sql: la lista no muestra cuántos paraderos tiene cada cotización y va más lenta con «Todo».</div>}
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between flex-wrap gap-1"><span>{listaVigente?<>{Math.min(nVisibles,filtradas.length)<filtradas.length?`Mostrando ${Math.min(nVisibles,filtradas.length)} · `:""}{filtradas.length} de {totC} en {rotuloPeriodo.toLowerCase()}{cargandoLista&&" · actualizando…"}</>:cargandoLista?"Cargando…":"—"}</span><span className="hidden sm:inline">AFA ERP · Comercial</span></div>
        </section>
      </main>
    </>
  );
}