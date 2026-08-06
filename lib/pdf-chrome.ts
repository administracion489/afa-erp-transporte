// Encabezado, pie y CSS base de los documentos imprimibles (cotización, ficha de ruta).
// Estaban dentro de app/cotizaciones/page.tsx; viven aquí para que cualquier documento
// nuevo herede el mismo membrete sin copiarlo, y para poder generarlo fuera del navegador.

export const LOGO_DEFAULT = "/logoafacotizacion-removebg-preview.png";

export function buildHeaderPDFHtml(logoUrl: string, cp: string, titulo: string, subtitulo: string): string {
  return `<div class="pdf-header" style="background:${cp};display:flex;align-items:stretch;height:65px;">
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

export function buildFooterPDFHtml(cp: string, empDir: string, empTel: string, empEmail: string, empWeb: string): string {
  return `<div class="pdf-footer" style="background:${cp};padding:9px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
    <span style="color:white;font-size:8.5px;">&#8962; Dir.: ${empDir}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9990; ${empTel}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9993; ${empEmail}</span>
    <span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>
    <span style="color:white;font-size:8.5px;">&#9741; ${empWeb}</span>
  </div>`;
}

export const sharedCSS = (extraCss = "") =>
  `@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0;padding:82px 15mm 55px;line-height:1.4}.pdf-header{position:fixed;top:0;left:0;right:0;z-index:100;}.pdf-footer{position:fixed;bottom:0;left:0;right:0;z-index:100;}.page-break{page-break-before:always}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}${extraCss}`;
