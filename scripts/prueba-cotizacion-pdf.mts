// @ts-nocheck — lleva copiados literal los generadores viejos de page.tsx (sin sus tipos): la comparación byte a byte es lo que se prueba, no los tipos.
// Matriz de lib/cotizacion-pdf.ts — npx tsx scripts/prueba-cotizacion-pdf.mts
//
// Las cuatro plantillas en ESPAÑOL y SOLES tienen que salir byte a byte iguales a los generadores
// VIEJOS de app/cotizaciones/page.tsx, copiados literal más abajo (escriben en una ventana; aquí la
// ventana es falsa y se captura lo escrito). Divergencias DECLARADAS, que la matriz aplica al HTML
// viejo antes de comparar: (1) la columna «USD ~» (importe / 3.7) de la ejecutiva desaparece;
// (2) el texto de usuario pasa por `esc` (los datos de prueba no llevan < > & " ', así que no
// cambia nada); (3) `Day N` también es encabezado de día del itinerario (no aparece en los datos);
// (5) un importe en soles con TRES decimales («S/ 1,833.333») sale al céntimo («S/ 1,833.33»):
// `fmtImporte` redondea con `alCentimo` —el de `cifrasDeFila` y `adelantoDe`— antes de formatear.
// Solo esos importes cambian; los que ya tenían dos decimales o menos salen byte a byte iguales.
import * as N from "../lib/cotizacion-pdf";
import { LOGO_DEFAULT, buildHeaderPDFHtml, buildFooterPDFHtml, sharedCSS, buildVehsHtml, esc, driveImg } from "../lib/pdf-chrome";
import { empresaConDefectos, cuentasParaMoneda } from "../lib/empresa-perfil";
import { etiquetaNivel } from "../lib/costos/nivel-servicio";
import { DEFAULT_CONSID_ES, fmtImporte } from "../lib/cotizacion-idioma";
import { alCentimo } from "../lib/cotizacion-moneda";
import { readFileSync } from "node:fs";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };

// ── Copia literal del código viejo ──────────────────────────────────────────────
type Cotizacion = any; type Cliente = any; type ItemCot = any; type VehiculoFlota = any; type ConsidCot = any; type CotPlantillaConfig = any; type EmpresaPerfilPDF = any; type VehiculoPDF = any;
const EMP = empresaConDefectos;
const DEFAULT_CONSID:ConsidCot={incluye:["Traslado de origen a destino","Conductor profesional certificado","Combustible durante todo el recorrido","GPS en tiempo real","Seguro de viaje SOAT vigente"],no_incluye:["Alimentación y bebidas","Guía turístico","Entradas a atractivos turísticos"],generales:["Precios según fechas y horarios coordinados.","Tolerancia máxima de espera: 30 minutos.","No se permite consumo de alcohol ni tabaco a bordo.","Cambios en ruta u horario pueden generar costos adicionales.","Servicio eventual: adelanto del 50% para confirmar.","Recomendamos reservar con 7 días de anticipación mínimo."]};
const calcItems=(items:ItemCot[],conIGV=true)=>{const s=items.reduce((t,it)=>t+it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100),0);return{subtotal:s,igv:conIGV?s*0.18:0,total:conIGV?s*1.18:s};};
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


function generarPDFModerno(cot:Cotizacion,cliente:Cliente|undefined,items:ItemCot[],vehiculos:VehiculoFlota[],repr:string,consid:ConsidCot,cfg:CotPlantillaConfig|null,empresa:EmpresaPerfilPDF|null){
  const conIGV=cot.incluye_igv!==false;
  const{subtotal,igv,total}=calcItems(items,conIGV);
  const nomCl=cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—";
  const nCot=cot.numero_cotizacion||String(cot.id).padStart(5,"0");
  const cp=cfg?.color_primario||"#1a1a2e"; const cs=cfg?.color_secundario||"#2f8ee9";
  const logoUrl=empresa?.logo_url||LOGO_DEFAULT;
  const empNombre=EMP(empresa).nombre;
  const empRuc=EMP(empresa).ruc; const empTel=EMP(empresa).telefono; const empEmail=EMP(empresa).email;
  const empWeb=EMP(empresa).web;
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
  const empNombre=EMP(empresa).nombre; const empTel=EMP(empresa).telefono; const empEmail=EMP(empresa).email;
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
  ${buildFooterPDFHtml(cp,empresa?.direccion||"",empTel,empEmail,EMP(empresa).web)}
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
  const empNombre=EMP(empresa).nombre; const empRuc=EMP(empresa).ruc; const empTel=EMP(empresa).telefono; const empEmail=EMP(empresa).email;
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
  ${buildFooterPDFHtml(cp,empresa?.direccion||"",empTel,empEmail,EMP(empresa).web)}
  <script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

// v2: muestra FECHA IDA + FECHA RETORNO separados cuando fecha_retorno está cargado
/**
 * EL BLOQUE DE CUENTAS BANCARIAS DEL PDF, ARMADO DESDE LA CONFIGURACIÓN.
 *
 * Estaba ESCRITO A MANO en el HTML con las cuentas reales de una empresa concreta — número de
 * cuenta y CCI, en BCP soles y dólares. Es el peor de todos los literales que tenía este
 * archivo: los demás imprimían un nombre equivocado; este manda el dinero al destinatario
 * equivocado. Un comprador cotiza, su cliente lee «nuestras cuentas bancarias» y transfiere…
 * a la cuenta de otro.
 *
 * Y los campos YA EXISTÍAN: `cot_plantilla_config` tiene `banco_1..3_{nombre,cuenta,cci}` y
 * `mostrar_cuentas_bancarias`, con su formulario en /cotizaciones/plantillas — que además ya
 * decía «ve a Configuración para editar las cuentas bancarias». La pantalla prometía algo que
 * el PDF no cumplía.
 *
 * SIN CUENTAS CONFIGURADAS NO SE IMPRIME EL BLOQUE. Ni un encabezado vacío ni un ejemplo: un
 * «Nuestras cuentas bancarias» sin nada debajo se lee como un documento a medio hacer, y
 * cualquier número de relleno es plata mandada a donde no es.
 */
function buildCuentasHtml(cfg: CotPlantillaConfig | null, empresa?: EmpresaPerfilPDF | null): string {
  if (cfg && cfg.mostrar_cuentas_bancarias === false) return "";

  // `usar_bancos_propios` significa que ESTA plantilla cobra en cuentas distintas de las de la
  // empresa. Apagado —el caso normal— manda la ficha de la empresa, que es donde vive la cuenta
  // a la que te pagan: con tres plantillas, el mismo número en tres sitios es tres sitios que
  // corregir el día que cambies de banco.
  if (!cfg?.usar_bancos_propios) {
    const deEmpresa = EMP(empresa).cuentas;
    if (deEmpresa.length) return pintarCuentas(deEmpresa);
    // Sin cuentas en la empresa se mira igual la plantilla: una base a la que le falte
    // `empresa-02` no puede perder el bloque que ya venía imprimiendo.
  }

  const cuentas = [1, 2, 3]
    .map(n => ({
      banco:  String((cfg as any)?.[`banco_${n}_nombre`] ?? "").trim(),
      cuenta: String((cfg as any)?.[`banco_${n}_cuenta`] ?? "").trim(),
      cci:    String((cfg as any)?.[`banco_${n}_cci`]    ?? "").trim(),
    }))
    // Basta con el nombre del banco y un número: una fila con solo el rótulo no dice dónde pagar.
    .filter(c => c.banco && (c.cuenta || c.cci));
  return pintarCuentas(cuentas);
}

function pintarCuentas(cuentas: { banco: string; cuenta: string; cci: string }[]): string {
  if (!cuentas.length) return "";
  return `<div class="cuentas"><h3>Nuestras cuentas bancarias</h3><div class="cuentas-grid">${
    cuentas.map(c => `<div class="cuenta-box"><div class="banco">${c.banco}</div>${
      c.cuenta ? `<p>Cta: ${c.cuenta}</p>` : ""}${c.cci ? `<p>CCI: ${c.cci}</p>` : ""}</div>`).join("")
  }</div></div>`;
}

function generarPDF(cot:Cotizacion,cliente:Cliente|undefined,items:ItemCot[],vehiculos:VehiculoFlota[],repr="",consid:ConsidCot=DEFAULT_CONSID,plantilla="corporativo",cfg:CotPlantillaConfig|null=null,empresa:EmpresaPerfilPDF|null=null){
  if(plantilla==="moderno_fotos"){generarPDFModerno(cot,cliente,items,vehiculos,repr,consid,cfg,empresa);return;}
  if(plantilla==="turistico"){generarPDFTuristico(cot,cliente,items,vehiculos,repr,consid,cfg,empresa);return;}
  if(plantilla==="ejecutivo"){generarPDFEjecutivo(cot,cliente,items,vehiculos,repr,consid,cfg,empresa);return;}
  // ── plantilla corporativo (original intacta, solo empresa_perfil si existe) ──
  const empNombre=EMP(empresa).nombre; const empRuc=EMP(empresa).ruc; const empEmail=EMP(empresa).email; const empTel=EMP(empresa).telefono; const empDir=EMP(empresa).direccion;
  const conIGV=cot.incluye_igv!==false;
  // Un servicio de solo ida no tiene punto ni hora de retorno: imprimirlos (y caer
  // al origen cuando punto_retorno está vacío) le promete al cliente un tramo que
  // no se cotizó. Sin tipo_servicio (cotizaciones antiguas) se conserva lo de antes.
  const soloIda=["solo_ida","fijo_solo_ida"].includes(cot.tipo_servicio||"");
  const{subtotal,igv,total}=calcItems(items,conIGV);const desc=items.reduce((s,it)=>s+it.dias*it.cantidad*it.precio_unit*(it.descuento_pct/100),0);
  const nomCl=cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—";
  const nCot=cot.numero_cotizacion||String(cot.id).padStart(5,"0");const anio=new Date().getFullYear();
  const fechaDoc=cot.created_at?new Date(cot.created_at).toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}):new Date().toLocaleDateString("es-PE");
  const vehsSec=buildVehsHtml(vehiculos,"#0b315f",{imgH:"180px",radius:"8px",contain:true});
  const filasItems=items.map((it,i)=>{const tf=it.dias*it.cantidad*it.precio_unit*(1-it.descuento_pct/100);return`<tr><td style="text-align:center;padding:6px;border:1px solid #ccc;">${i+1}</td><td style="padding:6px;border:1px solid #ccc;">${it.descripcion}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.dias}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.cantidad}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;">S/ ${it.precio_unit.toLocaleString("es-PE",{minimumFractionDigits:2})}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.descuento_pct>0?it.descuento_pct+"%":""}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;font-weight:bold;">S/ ${tf.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;}).join("");
  // El precio del PDF es el ya definido en los items: la nota de "Servicio Fijo"
  // con precio/día y mes estimado es cálculo interno y no debe verse en el documento.
  const notaFijo="";
  const css=sharedCSS(`.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.box{border:1px solid #ccc;border-radius:4px;padding:8px 10px}.box-title{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:6px}.box-row{margin:3px 0;font-size:10.5px}table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10.5px}thead{background:#0b315f;color:white}thead th{padding:6px;text-align:center;font-weight:700;font-size:10px;border:1px solid #0b315f}tbody tr:nth-child(even){background:#f8fafc}.totales td{padding:4px 10px}.totales .label{text-align:right;color:#555;font-weight:600}.totales .valor{text-align:right;font-weight:700}.totales .total-neto{font-size:13px;font-weight:900;color:#0b315f}.totales .sep{border-top:2px solid #0b315f}.cuentas{margin-top:12px;border-top:2px solid #0b315f;padding-top:10px}.cuentas h3{font-size:11px;font-weight:900;color:#0b315f;margin:0 0 6px}.cuentas-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.cuenta-box{border:1px solid #ddd;border-radius:4px;padding:6px 8px}.cuenta-box .banco{font-weight:900;font-size:10px;color:#0b315f;margin-bottom:3px}.cuenta-box p{margin:1px 0;font-size:9.5px}.anexo h3{font-size:10.5px;font-weight:900;margin:8px 0 4px;text-transform:uppercase}.anexo li{font-size:10.5px;color:#333;line-height:1.6}`);
  const totalesCorpHtml=(()=>{let h="<table class=\"totales\">";if(conIGV){h+=`<tr><td class="label">SUBTOTAL</td><td class="valor">S/ ${subtotal.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;if(desc>0)h+=`<tr><td class="label">DESCUENTO</td><td class="valor" style="color:#dc2626;">- S/ ${desc.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;h+=`<tr><td class="label">IGV (18%)</td><td class="valor">S/ ${igv.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;}h+=`<tr class="sep"><td class="label total-neto">TOTAL NETO</td><td class="valor total-neto">S/ ${total.toLocaleString("es-PE",{minimumFractionDigits:2})}</td></tr>`;if(!conIGV)h+="<tr><td colspan=\"2\" style=\"text-align:right;font-size:9px;color:#6b7280;padding:2px 10px 0;\">No incluye IGV</td></tr>";h+="</table>";return h;})();
  const saltoIncl=items.length>=3||vehiculos.length>=3?'<div style="page-break-before:always;height:70px;margin:0;"></div>':"";
  const win=window.open("","_blank");if(!win)return;
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Cotización N° ${nCot}</title><style>${css}</style></head><body>${buildHeaderPDFHtml(empresa?.logo_url||LOGO_DEFAULT,"#0b315f",`COTIZACIÓN N° ${nCot} - ${anio}`,`Fecha: ${fechaDoc} · Válida 30 días`)}<div class="grid2"><div class="box"><div class="box-title">Datos del cliente</div><div class="box-row"><b>CLIENTE:</b> ${nomCl}</div><div class="box-row"><b>${cliente?.ruc?"RUC":"DNI"}:</b> ${cliente?.ruc||cliente?.dni||"—"}</div><div class="box-row"><b>DIRECCIÓN:</b> ${cliente?.direccion||"—"}</div><div class="box-row"><b>CELULAR:</b> ${cliente?.telefono||"—"}</div><div class="box-row"><b>ATENCIÓN:</b> ${cot.atencion||cliente?.operativo_nombre||"—"}</div></div><div class="box"><div class="box-title">${empNombre}</div><div class="box-row"><b>RUC:</b> ${empRuc}</div>${repr?`<div class="box-row"><b>REPRESENTANTE:</b> ${repr}</div>`:""}<div class="box-row"><b>EMAIL:</b> ${empEmail}</div><div class="box-row"><b>TELF:</b> ${empTel}</div></div></div><div class="box" style="margin-bottom:10px;"><div class="box-title">Detalle del servicio</div><div style="display:grid;grid-template-columns:${soloIda?"1fr 1fr":"1fr 1fr 1fr"};gap:6px;"><div class="box-row"><b>ORIGEN:</b> ${cot.origen||"—"}</div><div class="box-row"><b>DESTINO:</b> ${cot.destino||"—"}</div>${soloIda?"":`<div class="box-row"><b>RETORNO:</b> ${cot.punto_retorno||cot.origen||"—"}</div>`}</div>${cot.asunto?`<div class="box-row" style="margin-top:4px;"><b>ASUNTO:</b> ${cot.asunto}</div>`:""}${cot.fecha_retorno?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"><div class="box-row"><b>FECHA IDA:</b> ${cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase():"_____________"}</div><div class="box-row"><b>HORA IDA:</b> <b>${cot.hora_ida||"_____"}</b></div><div class="box-row"><b>FECHA RETORNO:</b> ${new Date(cot.fecha_retorno+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase()}</div><div class="box-row"><b>HORA RETORNO:</b> <b>${cot.hora_retorno||"_____"}</b></div></div>`:`<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"><div class="box-row"><b>FECHA:</b> ${cot.fecha_servicio?new Date(cot.fecha_servicio+"T00:00:00").toLocaleDateString("es-PE",{day:"numeric",month:"long",year:"numeric"}).toUpperCase():"_____________"}</div><div class="box-row"><b>HORARIO:</b> Salida: <b>${cot.hora_ida||"_____"}</b>${soloIda?"":` | Retorno: <b>${cot.hora_retorno||"_____"}</b>`}</div></div>`}${notaFijo}</div>${buildCronogramaMultidiaPDF(cot,"#0b315f")}<table><thead><tr><th style="width:40px;">ITEM</th><th style="text-align:left;">DESCRIPCIÓN</th><th style="width:45px;">DÍAS</th><th style="width:55px;">CANT.</th><th style="width:110px;">P. UNIT S/ sin IGV</th><th style="width:55px;">% DSCTO.</th><th style="width:110px;">TOTAL S/</th></tr></thead><tbody>${filasItems}<tr><td colspan="7" style="border:1px solid #ccc;padding:0;vertical-align:top;">${totalesCorpHtml}</td></tr></tbody></table>${buildCuentasHtml(cfg,empresa)}${buildAnexoHtml(cot,nomCl,nCot,"#0b315f","#1d4ed8")}<div class="page-break"></div><h2 style="font-size:14px;font-weight:900;color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:6px;margin-bottom:16px;padding-top:82px;">Descripción de la unidad y condiciones</h2>${vehiculos.length?`<div class="box" style="margin-bottom:10px;"><div class="box-title">Características de la unidad${vehiculos.length>1?" · "+vehiculos.length+" vehículos":""}</div><div class="box-row">${vehsSec}</div></div>`:""}`+saltoIncl+`<div class="anexo"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;"><div><h3 style="color:#166534;border-bottom:2px solid #16a34a;padding-bottom:3px;">✅ Servicio incluye</h3><ul>${(cfg?.condiciones_incluye||consid.incluye).map(i=>`<li>${i}</li>`).join("")}</ul></div><div><h3 style="color:#991b1b;border-bottom:2px solid #dc2626;padding-bottom:3px;">❌ No incluye</h3><ul>${(cfg?.condiciones_no_incluye||consid.no_incluye).map(i=>`<li>${i}</li>`).join("")}</ul></div></div><h3 style="color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:3px;">📋 Consideraciones generales</h3><ul>${(cfg?.condiciones_generales||consid.generales).map(i=>`<li>${i}</li>`).join("")}</ul></div>${buildFooterPDFHtml("#0b315f",empDir,empTel,empEmail,EMP(empresa).web)}<script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

// pdf-chrome viejo (git HEAD), copiado literal
function footerViejo(cp: string, empDir: string, empTel: string, empEmail: string, empWeb: string): string {
  const partes = [
    { icono: "&#8962;", texto: empDir ? `Dir.: ${empDir}` : "" },
    { icono: "&#9990;", texto: empTel },
    { icono: "&#9993;", texto: empEmail },
    { icono: "&#9741;", texto: empWeb },
  ].filter(p => String(p.texto ?? "").trim());

  if (!partes.length) return `<div class="pdf-footer" style="background:${cp};padding:9px 20px;"></div>`;

  const sep = `<span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>`;
  return `<div class="pdf-footer" style="background:${cp};padding:9px 20px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;">
    ${partes.map(p => `<span style="color:white;font-size:8.5px;">${p.icono} ${p.texto}</span>`).join(sep)}
  </div>`;
}
function vehsViejo(vehiculos: VehiculoPDF[], cp: string, opts?: { imgH?: string; radius?: string; gap?: string; contain?: boolean }): string {
  if (!vehiculos.length) return "";
  const imgH = opts?.imgH || "200px"; const radius = opts?.radius || "12px"; const gap = opts?.gap || "12px"; const contain = opts?.contain || false;
  return vehiculos.map((veh, idx) => {
    const esFull = (veh.equipamiento || "full_equipo") === "full_equipo";
    const desc = veh.descripcion_unidad || (esFull
      ? `Bus con capacidad para ${veh.capacidad_pasajeros || "—"} pasajeros, con A/C, sistema de audio, asientos reclinables, bodega y GPS.`
      : `Bus con capacidad para ${veh.capacidad_pasajeros || "—"} pasajeros, estándar, bodega y GPS.`);
    const mkImg = (url: string) => contain
      ? `<div style="background:#f3f4f6;border-radius:${radius};border:1px solid #e5e7eb;height:${imgH};display:flex;align-items:center;justify-content:center;overflow:hidden;"><img src="${esc(driveImg(url))}" style="max-width:100%;max-height:${imgH};object-fit:contain;"/></div>`
      : `<div style="border-radius:${radius};overflow:hidden;height:${imgH};"><img src="${esc(driveImg(url))}" style="width:100%;height:100%;object-fit:cover;"/></div>`;
    const fotos = veh.foto_externa_url || veh.foto_interna_url
      ? `<div style="display:grid;grid-template-columns:${veh.foto_externa_url && veh.foto_interna_url ? "1fr 1fr" : "1fr"};gap:${gap};margin:10px 0;">${veh.foto_externa_url ? mkImg(veh.foto_externa_url) : ""}${veh.foto_interna_url ? mkImg(veh.foto_interna_url) : ""}</div>`
      : "";
    const sep = idx > 0 ? `<div style="height:1px;background:#e5e7eb;margin:10px 0 12px;"></div>` : "";
    // El MISMO rótulo que la pantalla y que la descripción del ítem: el cliente no puede leer
    // un rótulo en el anexo distinto del nivel con el que se le vendió el servicio.
    const tipoEquip = etiquetaNivel(veh.equipamiento);
    const lbl = vehiculos.length > 1
      ? `<p style="font-size:10px;font-weight:900;color:${cp};margin:0 0 5px;">${esc((veh.categoria || "UNIDAD").toUpperCase())} ${tipoEquip}${veh.capacidad_pasajeros ? " DE " + veh.capacidad_pasajeros + " PASAJEROS" : ""}</p>`
      : "";
    return `${sep}${lbl}<p style="color:#475569;font-size:11px;margin:0;">${esc(desc)}</p>${fotos}`;
  }).join("");
}

// ── Ventana falsa: lo que el código viejo escribe ───────────────────────────────
let escrito = "";
(globalThis as any).window = { open: () => ({ document: { write: (h: string) => { escrito = h; }, close: () => {} } }) };
function viejo(plantilla: string, cot: any, cl: any, items: any[], vehs: any[], repr: string, consid: any, cfg: any, emp: any): string {
  escrito = "";
  conImporteAlCentimo(() => generarPDF(cot, cl, items, vehs, repr, consid, plantilla, cfg, emp));
  return escrito
    .replace(/<th[^>]*>USD ~<\/th>/g, "")
    .replace(/<td[^>]*>USD -?[\d.]+<\/td>/g, "");
}
// Divergencia (5), aplicada al VALOR y no al texto ya impreso: el código viejo formatea cada
// importe en soles con `toLocaleString("es-PE",{minimumFractionDigits:2})`; aquí ese mismo
// llamado redondea antes con `alCentimo` y fija dos decimales, que es lo que hace `fmtImporte`.
// Redondear el TEXTO viejo sería un doble redondeo: «3,645.485» ya es 3645.48494 llevado a tres
// decimales por Intl, y daría 3,645.49 donde el céntimo es 3,645.48.
const tlsOriginal = Number.prototype.toLocaleString;
let importesMovidos = 0;
const RE_TRES_DECIMALES = /(S\/|US\$) -?[\d,]+\.\d{3}/;
function conImporteAlCentimo(f: () => void): void {
  Number.prototype.toLocaleString = function (this: number, loc?: any, op?: any) {
    if (op && op.minimumFractionDigits === 2 && op.maximumFractionDigits === undefined && Object.keys(op).length === 1) {
      const antes = tlsOriginal.call(this, loc, op);
      const c = alCentimo(Number(this));
      const despues = tlsOriginal.call(c === 0 ? 0 : c, loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (antes !== despues) importesMovidos++;
      return despues;
    }
    return tlsOriginal.call(this, loc, op);
  } as any;
  try { f(); } finally { Number.prototype.toLocaleString = tlsOriginal; }
}

// ── Datos ───────────────────────────────────────────────────────────────────────
const PLANTILLAS = ["corporativo", "moderno_fotos", "turistico", "ejecutivo"] as const;
const veh = (i: number, extra: any = {}) => ({ categoria: i % 2 ? "BUS" : null, capacidad_pasajeros: 20 + i, equipamiento: i % 2 ? "basico" : null, foto_externa_url: i === 1 ? "https://x.test/a.jpg" : null, foto_interna_url: i === 2 ? "https://x.test/b.jpg" : null, descripcion_unidad: i === 2 ? "Unidad con cortinas y TV" : null, ...extra });
const ITEMS = [
  [{ descripcion: "SERVICIO DE TRANSPORTE TURÍSTICO - Bus 50", dias: 1, cantidad: 1, precio_unit: 1200, descuento_pct: 0 }],
  [
    { descripcion: "Traslado Lima - Ica", dias: 2, cantidad: 1, precio_unit: 1833.3333, descuento_pct: 10 },
    { descripcion: "Guiado", dias: 1, cantidad: 3, precio_unit: 99.995, descuento_pct: 0 },
    { descripcion: "Peajes", dias: 1, cantidad: 1, precio_unit: 45.5, descuento_pct: 0 },
  ],
];
const CLIENTES = [
  undefined,
  { nombre: "Juan Pérez", tipo: "b2c", dni: "12345678", telefono: "999888777" },
  { nombre: "Contacto", empresa: "Minera Sur SAC", tipo: "b2b", ruc: "20123456789", direccion: "Av. Arequipa 123", operativo_nombre: "Ana" },
];
const EMPRESAS = [
  null,
  { nombre: "Transportes Demo", ruc: "20999999991", telefono: "01 555 1234", email: "ventas@demo.pe", web: "demo.pe", direccion: "Jr. Lima 100", logo_url: "https://x.test/logo.png", cuentas_bancarias: [{ banco: "BCP", cuenta: "191-111", cci: "002-191" }, { banco: "BBVA", cuenta: "", cci: "011-222" }] },
];
const CFGS = [
  null,
  { color_primario: "#123456", color_secundario: "#abcdef", color_acento: "#fedcba", titulo_documento: "MI TÍTULO", mensaje_cierre: "Gracias por su preferencia", mostrar_cuentas_bancarias: true, usar_bancos_propios: true, condiciones_incluye: ["Agua"], condiciones_no_incluye: null, condiciones_generales: ["Pago al contado."], banco_1_nombre: "Interbank", banco_1_cuenta: "200-300", banco_1_cci: "" },
  { mostrar_cuentas_bancarias: false, titulo_documento: "", mensaje_cierre: null },
];
const COTS = (k: number): any[] => {
  const base = { id: 42 + k, numero_cotizacion: k % 2 ? null : "COT-2026-0007", origen: "Lima", destino: "Paracas", km: k % 3 ? 250 : 0, atencion: k % 2 ? "Sr. Ruiz" : null, asunto: k % 3 ? "Paseo de fin de año" : null, punto_retorno: k % 4 ? "Miraflores" : null, fecha_servicio: k % 5 ? "2026-11-20" : null, fecha_retorno: k % 2 ? "2026-11-21" : null, hora_ida: k % 3 ? "06:30" : null, hora_retorno: k % 2 ? "18:00" : null, tipo_servicio: ["solo_ida", "ida_retorno", "fijo_solo_ida", null, "multi_dia"][k % 5], incluye_igv: [true, false, null][k % 3], itinerario_texto: k % 2 ? "Día 1\n06:30 - Salida de Lima\n\nLlegada a Paracas\nDIA 2\n10:00 – Islas Ballestas" : null, created_at: k % 3 ? "2026-10-01T15:00:00Z" : "", paradas_json: k % 2 ? [{ nombre: "Plaza San Martín", tipo: "inicio", hora: "06:30" }, { nombre: "", tipo: "destino", hora: "" }] : null, fechas_multidia_json: k % 4 === 1 ? [{ dia: 1, fecha: "2026-11-20", hora_ida: "06:00", destino_nombre: "Ica", hora_fin: "20:00", tipo_noche: "pernocte" }, { dia: 2, fecha: "2026-11-21", hora_ida: "", destino_nombre: "", tipo_noche: "cochera" }, { dia: 3, fecha: "", hora_ida: "07:00", destino_nombre: "Lima", hora_retorno: "19:00" }] : null };
  return [base];
};

console.log("1. Español + soles = generadores viejos, byte a byte (con las divergencias declaradas)");
{
  let n = 0, iguales = 0, mostrado = 0, conTres = 0;
  const reprs = ["", "Carla Díaz"];
  const considS = [DEFAULT_CONSID, { incluye: ["Conductor"], no_incluye: [], generales: ["Ninguna"] }];
  for (let k = 0; k < 20; k++) for (const cot of COTS(k)) for (const p of PLANTILLAS) for (const items of ITEMS) for (const cl of CLIENTES) for (const emp of EMPRESAS) for (const cfg of CFGS) {
    const vehs = [[], [veh(1)], [veh(0), veh(1), veh(2)]][(k + n) % 3];
    const repr = reprs[n % 2]; const consid = considS[(n >> 1) % 2];
    n++;
    const a = viejo(p, cot, cl, items, vehs, repr, consid, cfg, emp);
    const r = N.htmlCotizacion({ cot, cliente: cl, items, vehiculos: vehs, repr, consid, plantilla: p, cfg, empresa: emp });
    if (RE_TRES_DECIMALES.test(r.html!)) conTres++;
    if (r.html === a) iguales++;
    else if (mostrado++ < 2) {
      let i = 0; while (i < a.length && a[i] === r.html![i]) i++;
      console.log(`    ${p} k=${k}: difiere en ${i}\n      viejo: ${JSON.stringify(a.slice(i - 60, i + 80))}\n      nuevo: ${JSON.stringify(r.html!.slice(i - 60, i + 80))}`);
    }
  }
  ok(iguales === n, `${iguales}/${n} documentos idénticos`);
  ok(importesMovidos > 0, `la divergencia (5) sí se aplicó: ${importesMovidos} importes con tres decimales en los generadores viejos`);
  ok(conTres === 0, `ningún documento nuevo imprime un importe con tres decimales (${conTres}/${n})`);
}

console.log("2. Divergencias declaradas, comprobadas");
{
  const cot = { ...COTS(1)[0], tipo_servicio: "ida_retorno" };
  const items = ITEMS[1];
  escrito = ""; generarPDF(cot, CLIENTES[2], items, [], "", DEFAULT_CONSID, "ejecutivo", null, null);
  ok(/USD ~/.test(escrito) && /\/3\.7|USD \d/.test(escrito), "el viejo sí imprimía la columna USD ~");
  const r = N.htmlCotizacion({ cot, cliente: CLIENTES[2], items, vehiculos: [], plantilla: "ejecutivo" });
  ok(!/USD ~/.test(r.html!) && !/USD \d/.test(r.html!), "el nuevo no imprime ninguna conversión inventada");
  const codigo = readFileSync(new URL("../lib/cotizacion-pdf.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(!/\/\s*3\.7/.test(codigo), "ningún «/ 3.7» en el código del PDF");
  const malo = { ...cot, origen: "<script>alert(1)</script>", itinerario_texto: "Day 1\n<b>x</b>" };
  const rm = N.htmlCotizacion({ cot: malo, cliente: { nombre: "A & B <i>" }, items: [{ ...items[0], descripcion: "<img src=x onerror=1>" }], vehiculos: [], plantilla: "corporativo" });
  ok(!rm.html!.includes("<script>alert") && !rm.html!.includes("<img src=x") && !rm.html!.includes("<b>x</b>") && rm.html!.includes("A &amp; B &lt;i&gt;"), "texto de usuario escapado");
  ok(/font-weight:900;color:#0b315f;">Day 1<\/div>/.test(rm.html!), "«Day 1» es encabezado de día");

  // Divergencia (5), el caso que la fija: 84.75 + IGV. El viejo imprimía «S/ 15.255» y
  // «S/ 100.005»; el nuevo imprime el céntimo que calcula el ERP (alCentimo del total de
  // `totalesEnMoneda`, el mismo que lee `cifrasDeFila` y del que sale el adelanto).
  const cot5 = { ...COTS(0)[0], incluye_igv: true };
  const it5 = [{ descripcion: "Traslado", dias: 1, cantidad: 1, precio_unit: 84.75, descuento_pct: 0 }];
  escrito = ""; generarPDF(cot5, CLIENTES[1], it5, [], "", DEFAULT_CONSID, "corporativo", null, null);
  ok(escrito.includes("S/ 100.005") && escrito.includes("S/ 15.255"), "el viejo imprimía «S/ 100.005» y «S/ 15.255»");
  const tot5 = N.htmlCotizacion({ cot: cot5, cliente: CLIENTES[1], items: it5, vehiculos: [], plantilla: "corporativo" }).html!;
  ok(tot5.includes("S/ 100.01") && tot5.includes("S/ 15.26") && tot5.includes("S/ 84.75") && !RE_TRES_DECIMALES.test(tot5), "el nuevo: «S/ 84.75» + «S/ 15.26» = «S/ 100.01»");
  ok(fmtImporte(84.75 * 1.18, "PEN") === `S/ ${alCentimo(84.75 * 1.18).toFixed(2)}`, "lo impreso es alCentimo del total que calcula el ERP");
  // Sin doble redondeo: 76.275 × 1.18 = 90.0045; Intl a tres decimales lo imprimía «90.005», y
  // redondear ese texto daría 90.01. El céntimo es 90.00.
  const it6 = [{ ...it5[0], precio_unit: 76.275 }];
  escrito = ""; generarPDF(cot5, CLIENTES[1], it6, [], "", DEFAULT_CONSID, "turistico", null, null);
  const tot6 = N.htmlCotizacion({ cot: cot5, cliente: CLIENTES[1], items: it6, vehiculos: [], plantilla: "turistico" }).html!;
  ok(escrito.includes("S/ 90.005") && tot6.includes("S/ 90.00<") && !tot6.includes("S/ 90.01"), "90.0045 sale «S/ 90.00», no el doble redondeo «S/ 90.01»");
  // Lo que ya tenía dos decimales o menos no se mueve.
  const it7 = [{ ...it5[0], precio_unit: 1000 }];
  const a7 = viejo("ejecutivo", cot5, CLIENTES[1], it7, [], "", DEFAULT_CONSID, null, null);
  escrito = ""; generarPDF(cot5, CLIENTES[1], it7, [], "", DEFAULT_CONSID, "ejecutivo", null, null);
  const crudo7 = escrito.replace(/<th[^>]*>USD ~<\/th>/g, "").replace(/<td[^>]*>USD -?[\d.]+<\/td>/g, "");
  ok(a7 === crudo7 && N.htmlCotizacion({ cot: cot5, cliente: CLIENTES[1], items: it7, vehiculos: [], plantilla: "ejecutivo" }).html === crudo7, "con importes de dos decimales el viejo, sin la divergencia, y el nuevo son el mismo HTML");
}

console.log("3. pdf-chrome: los parámetros nuevos no cambian el comportamiento por defecto");
{
  let n = 0, ig = 0;
  for (const d of ["", "Jr. Lima 1"]) for (const t of ["", "999"]) for (const e of ["", "a@b.pe"]) for (const w of ["", "x.pe"]) {
    n++; if (buildFooterPDFHtml("#000", d, t, e, w) === footerViejo("#000", d, t, e, w)) ig++;
  }
  const vs = [[], [veh(0)], [veh(1), veh(2)], [veh(0), veh(1), veh(2), veh(3)]];
  const ops = [undefined, { imgH: "180px", radius: "8px", contain: true }, { imgH: "190px", gap: "4px" }];
  for (const v of vs) for (const o of ops) { n++; if (buildVehsHtml(v, "#111", o) === vehsViejo(v, "#111", o)) ig++; }
  ok(ig === n, `footer y unidades por defecto idénticos (${ig}/${n})`);
  ok(buildFooterPDFHtml("#000", "Jr. Lima", "", "", "", "en").includes("Address: Jr. Lima"), "footer en inglés");
}

console.log("4. Dólares: sin «S/» en importes, una línea de TC, PEN sin «US$»");
{
  const items = ITEMS[1];
  for (const p of PLANTILLAS) for (const igv of [true, false]) for (const idioma of ["es", "en"] as const) {
    const cot = { ...COTS(3)[0], incluye_igv: igv, moneda: "USD", tipo_cambio: 3.7512, idioma_pdf: idioma };
    const r = N.htmlCotizacion({ cot, cliente: CLIENTES[2], items, vehiculos: [veh(1)], plantilla: p, empresa: EMPRESAS[1] });
    const h = r.html!;
    const sinTc = h.replace(/S\/ [\d.,]+ (por|per) US\$/g, "");
    ok(!/S\/\s?\d/.test(sinTc), `${p} ${idioma} IGV=${igv}: ningún importe en soles`);
    ok((h.match(/(Tipo de cambio referencial|Reference exchange rate)/g) || []).length === 1, `${p} ${idioma}: TC impreso una vez`);
    ok(/US\$ [\d,]+\.\d\d/.test(h), `${p} ${idioma}: importes en US$`);
    const rp = N.htmlCotizacion({ cot: { ...cot, moneda: "PEN" }, cliente: CLIENTES[2], items, vehiculos: [], plantilla: p, empresa: EMPRESAS[1] });
    ok(!rp.html!.includes("US$") && !/referencial|exchange rate/.test(rp.html!), `${p} ${idioma}: PEN sin US$ ni TC`);
  }
  const sin = N.htmlCotizacion({ cot: { ...COTS(1)[0], moneda: "USD", tipo_cambio: null }, items: ITEMS[0], vehiculos: [] });
  ok(sin.html === null && sin.avisos.some(a => a.codigo === "sin_tc" && a.bloquea), "USD sin TC: no hay PDF, aviso sin_tc");
  const dsc = N.htmlCotizacion({ cot: { ...COTS(1)[0], moneda: "USD", tipo_cambio: 3.75, incluye_igv: true }, items: [{ descripcion: "x", dias: 1, cantidad: 1, precio_unit: 1000, descuento_pct: 0 }], vehiculos: [] });
  ok(dsc.html!.includes("US$ 266.67") && dsc.html!.includes("US$ 48.00") && dsc.html!.includes("US$ 314.67"), "S/ 1000 al 3.75: 266.67 + 48.00 = 314.67");
}

console.log("5. Cuentas por moneda");
{
  const emp = { ...EMPRESAS[1], cuentas_bancarias: [
    { banco: "BCP SOLES", cuenta: "111", cci: "", moneda: "PEN" },
    { banco: "BCP DOLARES", cuenta: "222", cci: "", moneda: "USD" },
    { banco: "BBVA", cuenta: "333", cci: "" },
  ] };
  const cot = { ...COTS(2)[0], tipo_cambio: 3.8 };
  const u = N.htmlCotizacion({ cot: { ...cot, moneda: "USD" }, items: ITEMS[0], vehiculos: [], empresa: emp }).html!;
  ok(u.includes("BCP DOLARES") && u.includes("BBVA") && !u.includes("BCP SOLES"), "USD: dólares + sin declarar, nunca soles");
  const s = N.htmlCotizacion({ cot: { ...cot, moneda: "PEN" }, items: ITEMS[0], vehiculos: [], empresa: emp }).html!;
  ok(s.includes("BCP SOLES") && s.includes("BBVA") && !s.includes("BCP DOLARES"), "PEN: soles + sin declarar, nunca dólares");
  const soloSoles = { ...emp, cuentas_bancarias: [emp.cuentas_bancarias[0]] };
  const r = N.htmlCotizacion({ cot: { ...cot, moneda: "USD" }, items: ITEMS[0], vehiculos: [], empresa: soloSoles });
  ok(!r.html!.includes("class=\"cuentas-grid\"") && r.avisos.some(a => a.codigo === "sin_cuenta_en_moneda"), "USD con solo cuentas en soles: sin bloque y con aviso");
  ok(cuentasParaMoneda([{ banco: "A", cuenta: "1", cci: "", moneda: "EUR" as any }], "USD").length === 1, "moneda desconocida = sin declarar");
}

// Seguridad: los campos numéricos vienen de un jsonb que acepta texto; nunca se imprimen crudos.
{
  const P = "<img src=x onerror=alert(1)>";
  for (const plantilla of ["corporativo", "moderno_fotos", "turistico", "ejecutivo"]) {
    const r = N.htmlCotizacion({
      cot: { id: 1, numero_cotizacion: "N", origen: "a", destino: "b", km: 1, created_at: "2026-01-01",
        fechas_multidia_json: [{ dia: P, fecha: "2026-01-01", hora_ida: "1", destino_nombre: "" }] } as any,
      items: [{ descripcion: "d", dias: P, cantidad: P, precio_unit: P, descuento_pct: P } as any],
      vehiculos: [{ capacidad_pasajeros: P, categoria: "x" } as any, { capacidad_pasajeros: P } as any],
      plantilla,
    } as any);
    ok(!(r.html ?? "").includes("<img src=x"), `${plantilla}: texto en campos numéricos no entra crudo al HTML`);
  }
}

console.log("6. Versión 2: las condiciones FIJADAS en la fila ganan en español (lib/cotizacion-plantillas.ts)");
{
  // Con `version: 2` el documento es el MISMO que el de la regla vieja con una plantilla SIN condiciones:
  // la fila manda, y todo lo demás de la plantilla (colores, título, cierre, cuentas) sigue igual.
  const sinListas = (cfg: any) => (cfg ? { ...cfg, condiciones_incluye: null, condiciones_no_incluye: null, condiciones_generales: null } : cfg);
  const filas = [DEFAULT_CONSID, { incluye: ["Conductor de la fila"], no_incluye: [], generales: ["General de la fila"] }];
  let n = 0, iguales = 0;
  for (let k = 0; k < 6; k++) for (const cot of COTS(k)) for (const p of PLANTILLAS) for (const cfg of CFGS) for (const fila of filas) for (const emp of EMPRESAS) {
    n++;
    const v2 = { ...fila, version: 2, plantilla: "corporativo" };
    const a = N.htmlCotizacion({ cot, cliente: CLIENTES[2], items: ITEMS[k % 2], vehiculos: [], repr: "", consid: v2, plantilla: p, cfg, empresa: emp }).html;
    const b = N.htmlCotizacion({ cot, cliente: CLIENTES[2], items: ITEMS[k % 2], vehiculos: [], repr: "", consid: fila, plantilla: p, cfg: sinListas(cfg), empresa: emp }).html;
    if (a === b) iguales++;
  }
  ok(iguales === n, `v2 = regla vieja con la plantilla sin condiciones: ${iguales}/${n}`);
  const cfg = CFGS[1];
  for (const p of PLANTILLAS) {
    const h = N.htmlCotizacion({ cot: COTS(1)[0], items: ITEMS[0], vehiculos: [], consid: { incluye: ["Conductor de la fila"], no_incluye: ["No de la fila"], generales: ["General de la fila"], version: 2 }, plantilla: p, cfg }).html!;
    ok(h.includes("Conductor de la fila") && !h.includes(">Agua<"), `${p}: con v2 imprime la fila y no la lista de la plantilla`);
  }
  // Sin `version` (todas las cotizaciones de antes), la plantilla sigue ganando: la sección 1 lo compara byte a byte.
  const h0 = N.htmlCotizacion({ cot: COTS(1)[0], items: ITEMS[0], vehiculos: [], consid: { incluye: ["Conductor de la fila"], no_incluye: [], generales: [] }, plantilla: "corporativo", cfg }).html!;
  ok(h0.includes(">Agua<") && !h0.includes("Conductor de la fila"), "sin versión: la regla de siempre (gana la plantilla)");
}

console.log("7. Colores de la plantilla: solo #RRGGBB entra al CSS (divergencia 4)");
{
  // Un color que no es #RRGGBB no se interpola: el documento es el MISMO que con el color por defecto
  // del diseño (sin color en la plantilla). `esc` no bastaba dentro de un style: «red;background:url(…)»
  // no lleva < > & " ' y entraba crudo.
  const malos = ["red;background:url(https://x.test/a.png)", "#12345", "#1234567", "rgb(1,2,3)", "#12345g", "  ", "javascript:alert(1)", "#123456;color:red"];
  const sinColor = { titulo_documento: "MI TÍTULO", mensaje_cierre: "Cierre" };
  for (const p of ["moderno_fotos", "turistico", "ejecutivo"] as const) {
    const ref = N.htmlCotizacion({ cot: COTS(1)[0], cliente: CLIENTES[2], items: ITEMS[0], vehiculos: [veh(1)], consid: DEFAULT_CONSID, plantilla: p, cfg: sinColor }).html!;
    let iguales = 0;
    for (const m of malos) {
      const h = N.htmlCotizacion({ cot: COTS(1)[0], cliente: CLIENTES[2], items: ITEMS[0], vehiculos: [veh(1)], consid: DEFAULT_CONSID, plantilla: p, cfg: { ...sinColor, color_primario: m, color_secundario: m, color_acento: m } }).html!;
      if (h === ref && !h.includes("x.test/a.png") && !h.includes("javascript:")) iguales++;
    }
    ok(iguales === malos.length, `${p}: ${iguales}/${malos.length} colores inválidos → el documento con el color por defecto`);
    const bueno = N.htmlCotizacion({ cot: COTS(1)[0], cliente: CLIENTES[2], items: ITEMS[0], vehiculos: [], consid: DEFAULT_CONSID, plantilla: p, cfg: { ...sinColor, color_primario: " #ABCDEF " } }).html!;
    ok(bueno.includes("#ABCDEF") && !bueno.includes(" #ABCDEF "), `${p}: un color válido con espacios entra recortado`);
  }
  ok(N.colorValido("#a1B2c3") && !N.colorValido("#a1b2c") && !N.colorValido(null) && N.colorCss("x", "#000000") === "#000000" && N.colorCss("#FFFFFF", "#000000") === "#FFFFFF", "colorValido / colorCss");
}

console.log("8. La política de reserva (cotizaciones-06): solo la corporativa, solo con líneas, después de las generales");
{
  // La cuarta lista: fijada en la fila (versión 2) o, en una fila de antes en castellano, la de la
  // plantilla (la misma regla que las otras tres). Sin ella, el HTML de siempre (sección 1).
  const POL = ["Se confirma con el 50 % de adelanto.", "Cancelación con 24 horas o más: sin costo."];
  const TIT = "📅 Reserva, cambios y cancelación";
  const fija = (reserva?: unknown) => ({ ...DEFAULT_CONSID, ...(reserva === undefined ? {} : { reserva }), version: 2, plantilla: "corporativo" }) as any;
  const html = (p: string, consid: any, cfg: any = null, idioma: any = "es") =>
    N.htmlCotizacion({ cot: COTS(1)[0], cliente: CLIENTES[2], items: ITEMS[0], vehiculos: [veh(1)], consid, plantilla: p, cfg, idioma }).html!;
  const sinEstilo = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/, "");
  const corp = sinEstilo(html("corporativo", fija(POL)));
  ok(corp.includes(TIT) && POL.every((l) => corp.includes(`<li>${l}</li>`)), "corporativo: imprime el título y las líneas");
  ok(corp.indexOf(TIT) > corp.indexOf("📋 Consideraciones generales") && corp.indexOf("📋 Consideraciones generales") > 0, "después de las Consideraciones generales");
  for (const p of ["moderno_fotos", "turistico", "ejecutivo"] as const) {
    ok(html(p, fija(POL)) === html(p, fija()), `${p}: no la imprime (el HTML es el de sin la política)`);
  }
  for (const [n, v] of [["[]", []], ["en blanco", ["", "  "]], ["null", null]] as const) {
    ok(html("corporativo", fija(v)) === html("corporativo", fija()), `corporativo con la política ${n}: el HTML de sin la política`);
  }
  ok(!sinEstilo(html("corporativo", fija())).includes("Reserva, cambios"), "sin la política: ni el título");
  // Fila de antes en castellano: la plantilla gana (la misma regla que las otras listas).
  const vieja = sinEstilo(html("corporativo", DEFAULT_CONSID, { condiciones_reserva: ["DE LA PLANTILLA"] }));
  ok(vieja.includes(TIT) && vieja.includes("<li>DE LA PLANTILLA</li>"), "fila de antes en castellano: la de la plantilla");
  ok(html("corporativo", DEFAULT_CONSID, { condiciones_reserva: null }) === html("corporativo", DEFAULT_CONSID, {}), "plantilla sin política (null): el HTML de siempre");
  // Fila fijada: la plantilla no se cuela.
  const v2 = sinEstilo(html("corporativo", fija(POL), { condiciones_reserva: ["DE LA PLANTILLA"] }));
  ok(v2.includes("<li>Se confirma con el 50 % de adelanto.</li>") && !v2.includes("DE LA PLANTILLA"), "fila fijada: la de la fila, no la de la plantilla");
  // En inglés: el título en inglés y las líneas tal cual (con el aviso).
  const en = N.htmlCotizacion({ cot: COTS(1)[0], cliente: CLIENTES[2], items: ITEMS[0], vehiculos: [veh(1)], consid: fija(POL), plantilla: "corporativo", idioma: "en" });
  ok(sinEstilo(en.html!).includes("📅 Booking, changes and cancellation") && sinEstilo(en.html!).includes(`<li>${POL[0]}</li>`), "en inglés: el título traducido y las líneas como se escribieron");
  ok(en.avisos.some((a) => a.codigo === "textos_escritos_tal_cual" && /reserva, cambios y cancelación/.test(a.detalle)), "en inglés: el aviso nombra la política");
  const enSin = N.htmlCotizacion({ cot: COTS(1)[0], cliente: CLIENTES[2], items: ITEMS[0], vehiculos: [veh(1)], consid: { ...DEFAULT_CONSID, incluye: ["Agua"] }, plantilla: "corporativo", idioma: "en" });
  ok(enSin.avisos.some((a) => a.codigo === "textos_escritos_tal_cual" && /las consideraciones \(incluye\)/.test(a.detalle)), "el aviso de las listas de siempre dice lo mismo que antes");
}

console.log("9. El resumen de la política con su enlace y su QR (cotizaciones-08)");
{
  // Sin resumen O sin enlace: la política entera, BYTE A BYTE. Con los dos: el resumen, el enlace y el QR.
  const POL = ["Se confirma con el 50 % de adelanto.", "Cancelación con 24 horas o más: sin costo.", "Si no se presenta, se cobra el 50 %."];
  const RES = ["Adelanto del 50 % para reservar.", "Cancelación gratis con 24 h o más."];
  const TOK = "123e4567-e89b-12d3-a456-426614174000";
  const ENL = `https://www.ejemplo.pe/condiciones/${TOK}`;
  const fija = (x: any = {}) => ({ ...DEFAULT_CONSID, reserva: POL, ...x, version: 2, plantilla: "corporativo" }) as any;
  const html = (p: string, consid: any, enlace?: unknown, cfg: any = null, idioma: any = "es") =>
    N.htmlCotizacion({ cot: COTS(1)[0], cliente: CLIENTES[2], items: ITEMS[0], vehiculos: [veh(1)], consid, plantilla: p, cfg, idioma, ...(enlace === undefined ? {} : { enlaceCondiciones: enlace as any }) }).html!;
  const sinEstilo = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/, "");
  const base = html("corporativo", fija());
  // (a) Lo de siempre, byte a byte: sin resumen (con o sin enlace), o con resumen y sin enlace válido.
  for (const [n, h] of [
    ["sin resumen ni enlace", html("corporativo", fija(), undefined)],
    ["sin resumen, con enlace", html("corporativo", fija(), ENL)],
    ["resumen vacío, con enlace", html("corporativo", fija({ reserva_resumen: [] }), ENL)],
    ["resumen en blanco, con enlace", html("corporativo", fija({ reserva_resumen: ["", "  "] }), ENL)],
    ["con resumen, sin enlace", html("corporativo", fija({ reserva_resumen: RES }), undefined)],
    ["con resumen, enlace null", html("corporativo", fija({ reserva_resumen: RES }), null)],
    ["con resumen, enlace inválido", html("corporativo", fija({ reserva_resumen: RES }), "https://otro.pe/x")],
    ["con resumen, enlace http", html("corporativo", fija({ reserva_resumen: RES }), `http://www.ejemplo.pe/condiciones/${TOK}`)],
  ] as const) ok(h === base, `${n}: el HTML de siempre (la política entera)`);
  // (b) Con resumen y enlace: el resumen en lugar de la política, el enlace y el QR.
  const r = sinEstilo(html("corporativo", fija({ reserva_resumen: RES }), ENL));
  ok(r !== sinEstilo(base), "con resumen y enlace, el documento cambia");
  ok(RES.every((l) => r.includes(`<li>${l}</li>`)) && !POL.some((l) => r.includes(`<li>${l}</li>`)), "imprime el resumen y no la política entera");
  ok(r.includes("Condiciones completas de reserva, cambios y cancelación:") && r.includes(`<a href="${ENL}"`) && r.includes(`>${ENL}</a>`), "con el rótulo y el enlace");
  ok(r.indexOf("📅 Reserva, cambios y cancelación") < r.indexOf(RES[0]) && r.indexOf(RES[0]) < r.indexOf("<svg") && r.indexOf("<svg") < r.indexOf(ENL), "título → resumen → QR → enlace");
  const svg = r.slice(r.indexOf("<svg"), r.indexOf("</svg>") + 6);
  ok(/viewBox="0 0 (\d+) \1"/.test(svg) && /width="96" height="96"/.test(svg) && !/https?:|data:|xlink/.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")), "el QR es un SVG en línea (sin pedir nada a la red ni data URL)");
  // El SVG dibuja EXACTAMENTE los módulos del QR (se reconstruye la matriz desde el path).
  const { matrizQr, casillaOscura, SILENCIO_QR } = await import("../lib/qr-matriz");
  const m = matrizQr(ENL)!;
  const d = svg.match(/<path d="([^"]+)"/)![1];
  const seg = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)].map((x) => [Number(x[2]) - SILENCIO_QR, Number(x[1]) - SILENCIO_QR, Number(x[3])]);
  ok(seg.length === m.tramos.length && JSON.stringify(seg) === JSON.stringify(m.tramos), `el path del SVG son los tramos de matrizQr (${seg.length})`);
  let malas = 0;
  for (let f = 0; f < m.tamano; f++) for (let c = 0; c < m.tamano; c++) if (seg.some(([sf, sc, sl]) => sf === f && c >= sc && c < sc + sl) !== casillaOscura(m, f, c)) malas++;
  ok(malas === 0, "casilla por casilla, el SVG es el QR");
  // (c) Solo la corporativa: las otras tres no imprimen ni la política ni el resumen.
  for (const p of ["moderno_fotos", "turistico", "ejecutivo"] as const) ok(html(p, fija({ reserva_resumen: RES }), ENL) === html(p, fija()), `${p}: no lo imprime`);
  // (d) Sin política no se imprime nada, aunque haya resumen y enlace.
  ok(html("corporativo", fija({ reserva: [], reserva_resumen: RES }), ENL) === html("corporativo", fija({ reserva: [] })), "sin política: ni el resumen ni el enlace");
  // (e) Fila de antes en castellano: gana la política de la plantilla y el resumen (que es de la fila) no se usa.
  const vieja = (cfg: any, enlace?: string) => html("corporativo", { ...DEFAULT_CONSID, reserva: POL, reserva_resumen: RES }, enlace, cfg);
  ok(vieja({ condiciones_reserva: ["DE LA PLANTILLA"], condiciones_reserva_resumen: ["RESUMEN DE LA PLANTILLA"] }, ENL) === vieja({ condiciones_reserva: ["DE LA PLANTILLA"], condiciones_reserva_resumen: ["RESUMEN DE LA PLANTILLA"] }) && sinEstilo(vieja({ condiciones_reserva: ["DE LA PLANTILLA"] }, ENL)).includes("<li>DE LA PLANTILLA</li>"), "fila de antes con política de la plantilla: la entera, sin resumen (el enlace abriría la de la fila)");
  ok(!sinEstilo(vieja({ condiciones_reserva_resumen: ["RESUMEN DE LA PLANTILLA"] }, ENL)).includes("RESUMEN DE LA PLANTILLA"), "el resumen de la plantilla nunca se imprime al imprimir (solo se copia al crear)");
  ok(sinEstilo(vieja({}, ENL)).includes(`<li>${RES[0]}</li>`), "fila de antes sin política de la plantilla: la de la fila, y con su resumen");
  // (f) En inglés: el rótulo traducido, el resumen tal cual.
  const en = sinEstilo(html("corporativo", fija({ reserva_resumen: RES }), ENL, null, "en"));
  ok(en.includes("Full booking, changes and cancellation terms:") && en.includes(`<li>${RES[0]}</li>`) && en.includes("<svg"), "en inglés: el rótulo en inglés y el resumen como se escribió");
  // (g) Un texto escrito con markup no entra crudo.
  const malo = sinEstilo(html("corporativo", fija({ reserva_resumen: ["<b>x</b> & \"y\""] }), ENL));
  ok(malo.includes("<li>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</li>"), "el resumen se escapa");
}

console.log("10. itemsEnIdioma: una descripción que el código escribió en inglés no se avisa como «escrita tal cual»");
{
  const cot = { ...COTS(2)[0], moneda: "PEN", idioma_pdf: "en", itinerario_texto: null };
  const items = [{ descripcion: "TRANSFER ONE WAY · Airport – Miraflores · Auto (up to 4 passengers) · price per leg", dias: 1, cantidad: 1, precio_unit: 100, descuento_pct: 0 }];
  const consid = { incluye: ["Bilingual driver"], no_incluye: [], generales: [], version: 2, idioma: "en" };
  for (const p of PLANTILLAS) {
    const sin = N.htmlCotizacion({ cot, items, vehiculos: [], plantilla: p, consid });
    const con = N.htmlCotizacion({ cot, items, vehiculos: [], plantilla: p, consid, itemsEnIdioma: true });
    const avisoSin = sin.avisos.find(a => a.codigo === "textos_escritos_tal_cual");
    ok(!!avisoSin && avisoSin.detalle.includes("descripción(es) de ítem"), `${p}: sin itemsEnIdioma, la descripción se avisa (como siempre)`);
    ok(!con.avisos.some(a => a.codigo === "textos_escritos_tal_cual"), `${p}: con itemsEnIdioma y condiciones en inglés, nada que avisar`);
    ok(con.html === sin.html, `${p}: itemsEnIdioma solo cambia el aviso, no el documento`);
  }
  // En castellano no hace nada.
  const es = { ...cot, idioma_pdf: "es" };
  for (const p of PLANTILLAS) {
    const a = N.htmlCotizacion({ cot: es, items: ITEMS[0], vehiculos: [], plantilla: p });
    const b = N.htmlCotizacion({ cot: es, items: ITEMS[0], vehiculos: [], plantilla: p, itemsEnIdioma: true });
    ok(a.html === b.html && JSON.stringify(a.avisos) === JSON.stringify(b.avisos), `${p}: en castellano, itemsEnIdioma no cambia nada`);
  }
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
