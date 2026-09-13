// Encabezado, pie y CSS base de los documentos imprimibles (cotización, ficha de ruta).
// Estaban dentro de app/cotizaciones/page.tsx; viven aquí para que cualquier documento
// nuevo herede el mismo membrete sin copiarlo, y para poder generarlo fuera del navegador.

import { etiquetaNivel } from "./costos/nivel-servicio";

export const LOGO_DEFAULT = "/logoafacotizacion-removebg-preview.png";

/**
 * Escapa texto que entra al HTML de un documento. Los documentos se abren con
 * document.write en una ventana que hereda el origen de la app, así que un dato de la
 * BD con markup (descripción de unidad, nombre de paradero) no puede entrar crudo.
 */
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * El logo se dimensiona contra el RECUADRO BLANCO, que es lo que se ve, no contra la banda.
 * La tarjeta blanca se estira a los 65px de la banda, así que lo único que limitaba el logo
 * era su propio `max-height`: con 46px y 8px de padding arriba y abajo sobraban 9px de blanco
 * por lado y el logo se leía pequeño dentro de su propio recuadro. Con 5px de padding quedan
 * 55px útiles y el tope sube a 54 — el logo de AFA (754×331) pasa de 105×46 a 123×54, un 38 %
 * más de área, y conserva 5.5px de blanco arriba y abajo: crece SIN pasar el recuadro.
 * Horizontalmente la tarjeta se ajusta al logo (entre 140 y 175), así que el hueco blanco de la
 * derecha —41px con el logo anterior— deja de ser mayor que el margen de los otros tres lados.
 * `justify-content:center` es para el logo de OTRA empresa (este ERP se vende): uno cuadrado no
 * llega al mínimo de 140 y sin eso quedaría pegado al borde izquierdo con todo el blanco detrás.
 */
export function buildHeaderPDFHtml(logoUrl: string, cp: string, titulo: string, subtitulo: string): string {
  return `<div class="pdf-header" style="background:${cp};display:flex;align-items:stretch;height:65px;">
    <div style="background:white;border-radius:0 20px 20px 0;padding:5px 18px 5px 14px;display:flex;align-items:center;justify-content:center;min-width:140px;max-width:175px;flex-shrink:0;">
      <img src="${logoUrl}" style="max-height:54px;max-width:140px;object-fit:contain;"/>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:flex-end;padding:0 24px;">
      <div style="text-align:right;">
        <p style="font-size:16px;font-weight:900;color:white;margin:0;letter-spacing:.3px;">${titulo}</p>
        <p style="font-size:9.5px;color:rgba(255,255,255,0.72);margin:3px 0 0;">${subtitulo}</p>
      </div>
    </div>
  </div>`;
}

/**
 * El membrete va CENTRADO en la banda. Sin `justify-content` el flex arranca a la izquierda y
 * los cuatro datos se apilaban contra el margen con la mitad derecha de la banda en azul vacío;
 * centrado, el pie queda simétrico como la banda que lo pinta. El `wrap` sigue puesto: cuando el
 * domicilio es largo el membrete pasa a dos líneas, y cada una se centra por su cuenta.
 */
export function buildFooterPDFHtml(cp: string, empDir: string, empTel: string, empEmail: string, empWeb: string): string {
  return `<div class="pdf-footer" style="background:${cp};padding:9px 20px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;">
    <span style="color:white;font-size:8.5px;">&#8962; Dir.: ${empDir}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9990; ${empTel}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9993; ${empEmail}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9741; ${empWeb}</span>
  </div>`;
}

/** Google Drive no sirve la imagen original en un <img>; hay que pedir la miniatura. */
export const driveImg = (url: string) => {
  if (!url) return url;
  const m = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || url.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w800` : url;
};

export type VehiculoPDF = {
  categoria: string | null;
  capacidad_pasajeros: number | null;
  equipamiento: string | null;
  foto_externa_url: string | null;
  foto_interna_url: string | null;
  descripcion_unidad: string | null;
};

/** Bloque de unidad con foto exterior/interior y descripción — el mismo en cotización y ficha. */
export function buildVehsHtml(vehiculos: VehiculoPDF[], cp: string, opts?: { imgH?: string; radius?: string; gap?: string; contain?: boolean }): string {
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

export const sharedCSS = (extraCss = "") =>
  `@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0;padding:82px 15mm 55px;line-height:1.4}.pdf-header{position:fixed;top:0;left:0;right:0;z-index:100;}.pdf-footer{position:fixed;bottom:0;left:0;right:0;z-index:100;}.page-break{page-break-before:always}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}${extraCss}`;
