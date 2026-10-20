// Encabezado, pie y CSS base de los documentos imprimibles (cotización, ficha de ruta).
// Estaban dentro de app/cotizaciones/page.tsx; viven aquí para que cualquier documento
// nuevo herede el mismo membrete sin copiarlo, y para poder generarlo fuera del navegador.

import { etiquetaNivel, nivelDeEquipamiento } from "./costos/nivel-servicio";

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
 * El pie del documento OMITE lo que no tiene dato, en vez de imprimir su rótulo vacío.
 *
 * Antes los cuatro campos iban siempre, así que un perfil a medio llenar imprimía
 * `⌂ Dir.: | ✆ | ✉ | ☏` — cuatro iconos y tres barras sin nada al lado, que se lee como un
 * documento roto. Y era el caso NORMAL: `empresa_perfil` nace vacía, y desde que los valores
 * de respaldo dejaron de ser los de una empresa concreta (ver `lib/empresa-perfil.ts`), un
 * campo sin llenar llega aquí como cadena vacía a propósito.
 *
 * Callar el rótulo es lo mismo que hace la autorización del regulador: sin dato no se inventa
 * nada, tampoco el hueco donde iría.
 *
 * Y lo que queda va CENTRADO en la banda. Sin `justify-content` el flex arranca a la izquierda
 * y los datos se apilaban contra el margen con la mitad derecha de la banda en azul vacío;
 * centrado, el pie queda simétrico como la banda que lo pinta — y con la omisión de arriba eso
 * pasa a ser lo que sostiene el pie de un perfil a medio llenar: dos datos alineados a la
 * izquierda dejan tres cuartos de banda vacíos, y eso sí se lee como un documento roto. El
 * `wrap` sigue puesto: con un domicilio largo el membrete pasa a dos líneas y cada una se
 * centra por su cuenta.
 */
export function buildFooterPDFHtml(cp: string, empDir: string, empTel: string, empEmail: string, empWeb: string, idioma: "es" | "en" = "es"): string {
  return pintarPieHtml(cp, partesPie(empDir, empTel, empEmail, empWeb, idioma));
}

/** Qué dato es cada parte del pie: el HTML le pone su ícono; el PDF del servidor (WinAnsi) no lo tiene. */
export type TipoPartePie = "direccion" | "telefono" | "email" | "web";
export type PartePie = { tipo: TipoPartePie; texto: string };

/** El ícono HTML de cada parte del pie (entidades: el documento se escribe con document.write). */
export const ICONO_PIE_HTML: Record<TipoPartePie, string> = { direccion: "&#8962;", telefono: "&#9990;", email: "&#9993;", web: "&#9741;" };

/**
 * Las partes del pie que SÍ tienen dato, en su orden (ver la cabecera de `buildFooterPDFHtml`).
 * El texto va tal cual llega: quien pinta HTML lo escapa (o lo recibe ya escapado).
 */
export function partesPie(empDir: string, empTel: string, empEmail: string, empWeb: string, idioma: "es" | "en" = "es"): PartePie[] {
  const partes: PartePie[] = [
    { tipo: "direccion", texto: empDir ? `${idioma === "en" ? "Address" : "Dir."}: ${empDir}` : "" },
    { tipo: "telefono", texto: empTel },
    { tipo: "email", texto: empEmail },
    { tipo: "web", texto: empWeb },
  ];
  return partes.filter(p => String(p.texto ?? "").trim());
}

/** El pie en HTML. El texto de cada parte se imprime TAL CUAL: quien llama decide si lo escapó. */
export function pintarPieHtml(cp: string, partes: PartePie[]): string {
  if (!partes.length) return `<div class="pdf-footer" style="background:${cp};padding:9px 20px;"></div>`;

  const sep = `<span style="color:rgba(255,255,255,0.4);font-size:9px;">|</span>`;
  return `<div class="pdf-footer" style="background:${cp};padding:9px 20px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;">
    ${partes.map(p => `<span style="color:white;font-size:8.5px;">${ICONO_PIE_HTML[p.tipo]} ${p.texto}</span>`).join(sep)}
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

/**
 * La descripción de la unidad que se imprime. La ESCRITA (`descripcion_unidad`) va tal cual en los
 * dos idiomas; sin ella, la que compone el sistema (y esa sí se traduce). Extraída de
 * `buildVehsHtml`, que la sigue usando: el PDF del servidor (lib/pdf-corporativo.ts) imprime la
 * MISMA frase que el HTML.
 */
export function descripcionVehiculoPdf(veh: VehiculoPDF, idioma: "es" | "en" = "es"): string {
  const en = idioma === "en";
  const esFull = (veh.equipamiento || "full_equipo") === "full_equipo";
  return veh.descripcion_unidad || (en
    ? (esFull
      ? `Bus with capacity for ${veh.capacidad_pasajeros || "—"} passengers, with A/C, audio system, reclining seats, luggage hold and GPS.`
      : `Bus with capacity for ${veh.capacidad_pasajeros || "—"} passengers, standard, luggage hold and GPS.`)
    : (esFull
      ? `Bus con capacidad para ${veh.capacidad_pasajeros || "—"} pasajeros, con A/C, sistema de audio, asientos reclinables, bodega y GPS.`
      : `Bus con capacidad para ${veh.capacidad_pasajeros || "—"} pasajeros, estándar, bodega y GPS.`));
}

/**
 * El rótulo de una unidad cuando el documento lleva VARIAS (con una sola no se imprime). El MISMO
 * rótulo que la pantalla y que la descripción del ítem: el cliente no puede leer un rótulo en el
 * anexo distinto del nivel con el que se le vendió el servicio.
 */
export function etiquetaVehiculoPdf(veh: VehiculoPDF, idioma: "es" | "en" = "es"): string {
  const en = idioma === "en";
  const tipoEquip = en ? (nivelDeEquipamiento(veh.equipamiento) === "full_equipo" ? "FULL EQUIPMENT" : "STANDARD") : etiquetaNivel(veh.equipamiento);
  return `${(veh.categoria || (en ? "UNIT" : "UNIDAD")).toUpperCase()} ${tipoEquip}${veh.capacidad_pasajeros ? (en ? " FOR " + veh.capacidad_pasajeros + " PASSENGERS" : " DE " + veh.capacidad_pasajeros + " PASAJEROS") : ""}`;
}

/** Una unidad del documento, en texto CRUDO (sin escapar): lo pintan el HTML y el PDF del servidor. */
export type VehiculoDoc = {
  /** Solo con varias unidades. */
  etiqueta: string | null;
  descripcion: string;
  fotoExterior: string | null;
  fotoInterior: string | null;
};

export function vehiculosDoc(vehiculos: VehiculoPDF[], idioma: "es" | "en" = "es"): VehiculoDoc[] {
  return vehiculos.map(veh => ({
    etiqueta: vehiculos.length > 1 ? etiquetaVehiculoPdf(veh, idioma) : null,
    descripcion: descripcionVehiculoPdf(veh, idioma),
    fotoExterior: veh.foto_externa_url || null,
    fotoInterior: veh.foto_interna_url || null,
  }));
}

/** Bloque de unidad con foto exterior/interior y descripción — el mismo en cotización y ficha. */
export function buildVehsHtml(vehiculos: VehiculoPDF[], cp: string, opts?: { imgH?: string; radius?: string; gap?: string; contain?: boolean; idioma?: "es" | "en" }): string {
  if (!vehiculos.length) return "";
  return pintarVehiculosHtml(vehiculosDoc(vehiculos, opts?.idioma === "en" ? "en" : "es"), cp, opts);
}

/** El HTML de las unidades ya resueltas (`vehiculosDoc`). Escapa todo lo que imprime. */
export function pintarVehiculosHtml(vehs: VehiculoDoc[], cp: string, opts?: { imgH?: string; radius?: string; gap?: string; contain?: boolean }): string {
  if (!vehs.length) return "";
  const imgH = opts?.imgH || "200px"; const radius = opts?.radius || "12px"; const gap = opts?.gap || "12px"; const contain = opts?.contain || false;
  return vehs.map((veh, idx) => {
    const mkImg = (url: string) => contain
      ? `<div style="background:#f3f4f6;border-radius:${radius};border:1px solid #e5e7eb;height:${imgH};display:flex;align-items:center;justify-content:center;overflow:hidden;"><img src="${esc(driveImg(url))}" style="max-width:100%;max-height:${imgH};object-fit:contain;"/></div>`
      : `<div style="border-radius:${radius};overflow:hidden;height:${imgH};"><img src="${esc(driveImg(url))}" style="width:100%;height:100%;object-fit:cover;"/></div>`;
    const fotos = veh.fotoExterior || veh.fotoInterior
      ? `<div style="display:grid;grid-template-columns:${veh.fotoExterior && veh.fotoInterior ? "1fr 1fr" : "1fr"};gap:${gap};margin:10px 0;">${veh.fotoExterior ? mkImg(veh.fotoExterior) : ""}${veh.fotoInterior ? mkImg(veh.fotoInterior) : ""}</div>`
      : "";
    const sep = idx > 0 ? `<div style="height:1px;background:#e5e7eb;margin:10px 0 12px;"></div>` : "";
    const lbl = veh.etiqueta != null
      ? `<p style="font-size:10px;font-weight:900;color:${cp};margin:0 0 5px;">${esc(veh.etiqueta)}</p>`
      : "";
    return `${sep}${lbl}<p style="color:#475569;font-size:11px;margin:0;">${esc(veh.descripcion)}</p>${fotos}`;
  }).join("");
}

export const sharedCSS = (extraCss = "") =>
  `@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0;padding:82px 15mm 55px;line-height:1.4}.pdf-header{position:fixed;top:0;left:0;right:0;z-index:100;}.pdf-footer{position:fixed;bottom:0;left:0;right:0;z-index:100;}.page-break{page-break-before:always}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}${extraCss}`;
